import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import OpenAI from "openai";

type SeenItem = {
  sourceUrl: string;
  contentHash: string;
  originalTitle: string;
  sourceDate: string;
  createdFile: string;
  createdAt: string;
};

type SourceItem = {
  title: string;
  sourceDate: string;
  sourceUrl: string;
  sourceName: string;
};

type ArticleDraft = {
  title: string;
  slug: string;
  category: "zpravy" | "kultura" | "sport" | "akce" | "servis";
  excerpt: string;
  body: string;
  answerQuestion: string;
  answerText: string;
  riskLevel: "low" | "medium" | "high";
};

const rootDir = process.cwd();
const seenPath = path.join(rootDir, "data", "seen.json");
const articlesDir = path.join(rootDir, "src", "content", "articles");
const maxItems = Number(process.env.ZNOJMO_MAX_ITEMS ?? "20");
const defaultTipSourceUrls = [
  "https://www.znojemsko.cz/",
  "https://znojemsky.denik.cz/",
  "https://www.idnes.cz/brno/zpravy/zpravy-ze-znojma-a-okoli.K8076",
  "https://hcorli.cz/",
  "https://www.1scznojmo.cz/",
  "https://www.muzeumznojmo.cz/",
  "https://znojemskabeseda.com/",
  "https://www.znojmozije.cz/",
  "https://www.kinoznojmo.cz/",
  "https://webext1.nemzn.cz/",
  "https://lesyznojmo.cz/",
  "https://www.gymzn.cz/",
  "https://znojmo.charita.cz/"
];

const pressSourceUrl = process.env.ZNOJMO_PRESS_SOURCE_URL?.trim();
const tipSourceUrls = splitEnvUrls(process.env.ZNOJMO_TIP_SOURCE_URLS);
const openAiKey = process.env.OPENAI_API_KEY?.trim();
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

const client = openAiKey ? new OpenAI({ apiKey: openAiKey }) : null;

async function main() {
  const sourceUrls = [...new Set([pressSourceUrl, ...(tipSourceUrls.length > 0 ? tipSourceUrls : defaultTipSourceUrls)])].filter(
    (url): url is string => Boolean(url)
  );

  if (sourceUrls.length === 0) {
    console.log("Skipping scrape: missing env ZNOJMO_PRESS_SOURCE_URL or ZNOJMO_TIP_SOURCE_URLS.");
    return;
  }

  if (!openAiKey) {
    console.log("Skipping scrape: missing env OPENAI_API_KEY.");
    return;
  }

  const seen = await readSeen();
  const sourceItems = (
    await Promise.all(sourceUrls.map(async (sourceUrl) => extractSourceItems(await fetchText(sourceUrl), sourceUrl)))
  )
    .flat()
    .sort((a, b) => b.sourceDate.localeCompare(a.sourceDate))
    .slice(0, maxItems);

  if (sourceItems.length === 0) {
    console.log("No press release links found.");
    return;
  }

  let createdCount = 0;

  for (const item of sourceItems) {
    if (seen.some((seenItem) => seenItem.sourceUrl === item.sourceUrl)) {
      continue;
    }

    const detailHtml = await fetchText(item.sourceUrl);
    const detail = extractDetail(detailHtml, item);
    const contentHash = hashText(`${detail.title}\n${detail.sourceDate}\n${detail.text}`);

    if (seen.some((seenItem) => seenItem.contentHash === contentHash)) {
      continue;
    }

    const draft = await createDraftWithOpenAI(detail.title, detail.sourceDate, detail.text, detail.sourceName, item.sourceUrl);
    const fileName = `${draft.slug}.md`;
    const createdFile = path.join("src", "content", "articles", fileName);
    const filePath = path.join(rootDir, createdFile);

    await mkdir(articlesDir, { recursive: true });
    await writeFile(filePath, toMarkdown(draft, detail.sourceDate, item.sourceUrl, detail.sourceName), "utf8");

    seen.push({
      sourceUrl: item.sourceUrl,
      contentHash,
      originalTitle: detail.title,
      sourceDate: detail.sourceDate,
      createdFile,
      createdAt: new Date().toISOString()
    });

    createdCount += 1;
    console.log(`Created draft: ${createdFile}`);
  }

  await writeFile(seenPath, `${JSON.stringify(seen, null, 2)}\n`, "utf8");
  console.log(`Done. Created ${createdCount} draft article(s).`);
}

async function readSeen(): Promise<SeenItem[]> {
  try {
    const raw = await readFile(seenPath, "utf8");
    return JSON.parse(raw) as SeenItem[];
  } catch {
    return [];
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "2cityBot/0.1 (+https://znojmo-za-5-minut.pages.dev)"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function extractSourceItems(html: string, baseUrl: string): SourceItem[] {
  const $ = cheerio.load(html);
  const items = new Map<string, SourceItem>();
  const sourceHost = new URL(baseUrl).hostname.replace(/^www\./, "");

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const title = cleanText($(element).text());

    if (!href || title.length < 8) {
      return;
    }

    const sourceUrl = new URL(href, baseUrl).toString();

    if (!isPressReleaseCandidate(sourceUrl, title, sourceHost)) {
      return;
    }

    const localText = cleanText($(element).closest("article, li, div, tr").text());
    const sourceDate = parseCzechDate(localText) ?? parseCzechDate(title) ?? today();

    items.set(sourceUrl, {
      title,
      sourceDate,
      sourceUrl,
      sourceName: sourceNameFromUrl(sourceUrl)
    });
  });

  return [...items.values()].sort((a, b) => b.sourceDate.localeCompare(a.sourceDate));
}

function isPressReleaseCandidate(sourceUrl: string, title: string, sourceHost: string): boolean {
  const url = new URL(sourceUrl);
  const host = url.hostname.replace(/^www\./, "");
  const path = decodeURIComponent(url.pathname).toLowerCase();
  const combined = `${title} ${path}`.toLowerCase();

  if (host !== sourceHost || url.hash) {
    return false;
  }

  if (host.includes("znojmocity.cz") && !/\/d-\d+/.test(url.pathname)) {
    return false;
  }

  if (/zamer|záměr|pronajmu|pronájmu|prodej|uredni|úřední|deska|vyhlaska|vyhláška|verejna-vyhlaska|veřejná-vyhláška/.test(combined)) {
    return false;
  }

  if (host.includes("denik.cz") || host.includes("idnes.cz") || host.includes("znojemsko.cz")) {
    return /znojm|moravsk|jihomorav|dukova|nezamest|nezaměst|ekonom|prace|práce|dopr|nemoc|skol|škol|polic|hasic|hasič|soud|sport|kultur|festival|volby|energie/.test(combined);
  }

  return /radnic|sport|studii|studie|knih|pamat|památ|senior|skol|škol|dopr|festival|kultur|vystav|výstav|ocenen|oceněn|novink|nemoc|charit|kino|muze/.test(combined);
}

function extractDetail(html: string, fallback: SourceItem) {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, aside, form, noscript, iframe, svg").remove();

  const title = cleanText(
    $("h1").first().text() ||
    $("meta[property='og:title']").attr("content") ||
    fallback.title
  );

  const sourceDate =
    parseCzechDate($("time[datetime]").first().attr("datetime") ?? "") ??
    parseCzechDate($("time").first().text()) ??
    parseCzechDate($("main, article, body").first().text()) ??
    fallback.sourceDate;

  const contentRoot =
    $("article").first().length ? $("article").first() :
    $("main").first().length ? $("main").first() :
    $(".content, .article, .detail, #content").first().length ? $(".content, .article, .detail, #content").first() :
    $("body");

  contentRoot.find("a, button").each((_, element) => {
    const text = cleanText($(element).text());
    if (/zpět|sdílet|tisk|facebook|twitter|menu|vyhled/i.test(text)) {
      $(element).remove();
    }
  });

  const paragraphs = contentRoot
    .find("p, li")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter((text) => text.length > 40 && !/cookie|souhlas|navigace|sociální sítě/i.test(text));

  const text = paragraphs.length > 0 ? paragraphs.join("\n\n") : cleanText(contentRoot.text());

  if (text.length < 120) {
    throw new Error(`Could not extract enough article text from ${fallback.sourceUrl}.`);
  }

  return {
    title,
    sourceDate,
    text,
    sourceName: fallback.sourceName
  };
}

async function createDraftWithOpenAI(originalTitle: string, sourceDate: string, sourceText: string, sourceName: string, sourceUrl: string): Promise<ArticleDraft> {
  if (!client) {
    throw new Error("OpenAI client is not configured.");
  }

  const response = await client.responses.create({
    model: openAiModel,
    input: [
      {
        role: "system",
        content: [
          "Jsi zkušený český editor regionálního zpravodajství pro Znojmo a okolí.",
          "Piš jako redaktor běžného českého regionálního webu: jasně, věcně, česky, v krátkých odstavcích.",
          "Text nesmí vyznít jako PR radnice, úřadu, městské firmy ani politika.",
          "Necituj politiky a neuváděj jejich jména. Výjimkou je pouze novinářská kritika, kontrola moci nebo reflexe sporného jednání.",
          "Neformuluj titulky tak, že město něco chválíš nebo prezentuješ. Hledej neutrální otázku, dopad na lidi nebo konkrétní změnu.",
          "U zdrojů z radnice nebo městských organizací vždy polož čtenářskou otázku: Co se mění? Koho se to dotkne? Kolik to bude stát? Kdy to začne? Co zůstává nejasné? Alespoň title nebo answerQuestion musí být otázka.",
          "Nepoužívej marketing, úřední jazyk ani AI fráze typu významný krok, komplexní informace, přibližuje novým způsobem, aktivní účast občanů.",
          "Nepřidávej hodnocení, spekulace ani obecné závěry. Neopisuj celé tiskové zprávy.",
          "Nikdy do článku nepiš redakční poznámky, metodiku výběru témat ani věty o tom, že pro regionální přehled má něco smysl. Čtenář má dostat zprávu, ne vysvětlení procesu.",
          "Nepoužívej prázdné závěrečné disclaimerové věty typu aktuální informace ověřte na webu, podrobnosti najdete u pořadatele, termíny se mohou měnit. Pokud je termín nebo místo nejisté, napiš konkrétně, co není jisté, jinak větu vynech.",
          "Zdroje jako Znojemsko.cz, Znojemský deník nebo iDNES používej jen jako redakční tip na téma. Nepřebírej jejich zamčené ani autorské texty. Pokud téma pochází z média, hledej původní veřejný zdroj, například obec, instituci, pořadatele, policii, hasiče, nemocnici, školu, úřad práce, ČEZ, dopravce nebo sportovní klub.",
          "Silné regionální téma může být i mimo samotné město: Dukovany, ekonomika, zaměstnanost, doprava, zdravotnictví, školy, bezpečnost, větší kulturní akce nebo sport. Zařaď ho jen tehdy, když má zřejmý dopad na lidi ze Znojma a okolí.",
          "Pokud původní veřejný zdroj nelze dohledat, napiš pouze velmi stručný přehled z veřejně dostupného titulku a perexu, jasně drž nízkou míru detailu a nastav riskLevel na high.",
          "Vracej pouze validní JSON."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          "Zpracuj zdrojový text do návrhu krátkého regionálního článku pro web 2city.",
          "Výstup musí být JSON s poli: title, slug, category, excerpt, body, answerQuestion, answerText, riskLevel.",
          "category nastav na jednu z hodnot: zpravy, kultura, sport, akce, servis.",
          "Záměry pronájmu, úřední desku, obecné rozcestníky a interní úřední provoz raději označ jako servis a riskLevel high.",
          "title piš jako neutrální novinový titulek pro běžné čtenáře, ne jako úřední název dokumentu ani PR sdělení.",
          "Dobré titulky: Jaká bude budoucnost Lesky? Kdy začne senior taxi? Co se mění v prázdninovém provozu školek?",
          "Špatné titulky: Město představí studii, Radnice zve veřejnost, Projekt získal významné ocenění.",
          "excerpt napiš jednou konkrétní větou bez prázdných slov.",
          "answerText napiš ve 2 až 3 krátkých větách.",
          "body napiš jako 3 až 5 krátkých odstavců. Každý odstavec má nést novou informaci.",
          "Každý odstavec musí obsahovat konkrétní informaci z textu: kdo, co, kdy, kde, dopad, změna, číslo, termín nebo kontext. Pokud takovou informaci nemáš, odstavec nepiš.",
          "U článků typu akce nebo přehled akcí nepiš obecné kategorie. Uveď konkrétní názvy akcí, termíny, místa nebo pořadatele. Pokud nemáš aspoň dva konkrétní příklady, nastav riskLevel na high.",
          "slug používej bez diakritiky, malými písmeny, oddělený pomlčkami.",
          "riskLevel nastav na low, medium nebo high podle toho, jak moc text vyžaduje lidské ověření.",
          "body vrať jako Markdown bez frontmatteru.",
          "Nepoužívej slova a obraty: komplexní, významný, přispělo k, je neodmyslitelnou součástí, obyvatelé mají šanci, v souladu s moderními požadavky, radnice zve, město představí, pro regionální přehled, aktuální informace, je nejlepší kontrolovat, vyplatí se ověřit.",
          "Pokud text není aktualita nebo tisková zpráva pro veřejnost, nastav riskLevel na high a titulkem naznač, že vyžaduje kontrolu.",
          `Název zdroje: ${sourceName}`,
          `URL zdroje: ${sourceUrl}`,
          `Původní titulek: ${originalTitle}`,
          `Datum zdroje: ${sourceDate}`,
          `Text zdroje:\n${sourceText.slice(0, 12000)}`
        ].join("\n\n")
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "article_draft",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            slug: { type: "string" },
            category: { type: "string", enum: ["zpravy", "kultura", "sport", "akce", "servis"] },
            excerpt: { type: "string" },
            body: { type: "string" },
            answerQuestion: { type: "string" },
            answerText: { type: "string" },
            riskLevel: { type: "string", enum: ["low", "medium", "high"] }
          },
          required: ["title", "slug", "category", "excerpt", "body", "answerQuestion", "answerText", "riskLevel"]
        }
      }
    }
  });

  const text = response.output_text;
  const draft = JSON.parse(text) as ArticleDraft;

  return {
    ...draft,
    slug: slugify(draft.slug || draft.title)
  };
}

function toMarkdown(draft: ArticleDraft, sourceDate: string, sourceUrl: string, sourceName: string): string {
  const frontmatter = {
    title: draft.title,
    slug: draft.slug,
    date: today(),
    sourceName,
    sourceDate,
    sourceUrl,
    draft: draft.riskLevel === "high",
    category: draft.category,
    excerpt: draft.excerpt,
    answerQuestion: draft.answerQuestion,
    answerText: draft.answerText,
    riskLevel: draft.riskLevel
  };

  return `---\n${Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : JSON.stringify(value)}`)
    .join("\n")}\n---\n\n${draft.body.trim()}\n`;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitEnvUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function sourceNameFromUrl(sourceUrl: string): string {
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "");

  if (host.includes("znojmocity.cz")) return "Znojmocity.cz";
  if (host.includes("znojemsky.denik.cz")) return "Znojemský deník";
  if (host.includes("idnes.cz")) return "iDNES.cz";
  if (host.includes("znojemsko.cz")) return "Znojemsko.cz";
  if (host.includes("hcorli.cz")) return "HC Orli Znojmo";
  if (host.includes("1scznojmo.cz")) return "1. SC Znojmo";
  if (host.includes("muzeumznojmo.cz")) return "Jihomoravské muzeum ve Znojmě";
  if (host.includes("znojemskabeseda.com")) return "Znojemská Beseda";
  if (host.includes("kinoznojmo.cz")) return "Kino Znojmo";
  if (host.includes("nemzn.cz")) return "Nemocnice Znojmo";
  if (host.includes("znojmo.charita.cz")) return "Charita Znojmo";

  return host;
}

function hashText(value: string): string {
  return createHash("sha256").update(cleanText(value).toLowerCase()).digest("hex");
}

function today(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(new Date());
}

function parseCzechDate(value: string): string | null {
  const normalized = value.toLowerCase();
  const isoMatch = normalized.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);

  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  }

  const numericMatch = normalized.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d{2})/);

  if (numericMatch) {
    return `${numericMatch[3]}-${numericMatch[2].padStart(2, "0")}-${numericMatch[1].padStart(2, "0")}`;
  }

  const months: Record<string, string> = {
    ledna: "01",
    leden: "01",
    unora: "02",
    "února": "02",
    unor: "02",
    "únor": "02",
    brezna: "03",
    "března": "03",
    brezen: "03",
    "březen": "03",
    dubna: "04",
    duben: "04",
    kvetna: "05",
    "května": "05",
    kveten: "05",
    "květen": "05",
    cervna: "06",
    "června": "06",
    cerven: "06",
    "červen": "06",
    cervence: "07",
    "července": "07",
    cervenec: "07",
    "červenec": "07",
    srpna: "08",
    srpen: "08",
    zari: "09",
    "září": "09",
    rijna: "10",
    "října": "10",
    rijen: "10",
    "říjen": "10",
    listopadu: "11",
    listopad: "11",
    prosince: "12",
    prosinec: "12"
  };

  const namedMatch = normalized.match(/(\d{1,2})\.?\s+([a-zá-ž]+)\s+(20\d{2})/i);

  if (!namedMatch) {
    return null;
  }

  const month = months[namedMatch[2]];

  if (!month) {
    return null;
  }

  return `${namedMatch[3]}-${month}-${namedMatch[1].padStart(2, "0")}`;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "navrh-clanku";
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});

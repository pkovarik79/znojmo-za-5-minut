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
};

type ArticleDraft = {
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  answerQuestion: string;
  answerText: string;
  riskLevel: "low" | "medium" | "high";
};

const rootDir = process.cwd();
const seenPath = path.join(rootDir, "data", "seen.json");
const articlesDir = path.join(rootDir, "src", "content", "articles");
const sourceName = "Město Znojmo";
const maxItems = Number(process.env.ZNOJMO_MAX_ITEMS ?? "10");

const pressSourceUrl = process.env.ZNOJMO_PRESS_SOURCE_URL?.trim();
const openAiKey = process.env.OPENAI_API_KEY?.trim();
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

const client = openAiKey ? new OpenAI({ apiKey: openAiKey }) : null;

async function main() {
  if (!pressSourceUrl) {
    console.log("Skipping scrape: missing env ZNOJMO_PRESS_SOURCE_URL.");
    return;
  }

  if (!openAiKey) {
    console.log("Skipping scrape: missing env OPENAI_API_KEY.");
    return;
  }

  const seen = await readSeen();
  const listHtml = await fetchText(pressSourceUrl);
  const sourceItems = extractSourceItems(listHtml, pressSourceUrl).slice(0, maxItems);

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

    const draft = await createDraftWithOpenAI(detail.title, detail.sourceDate, detail.text);
    const fileName = `${draft.slug}.md`;
    const createdFile = path.join("src", "content", "articles", fileName);
    const filePath = path.join(rootDir, createdFile);

    await mkdir(articlesDir, { recursive: true });
    await writeFile(filePath, toMarkdown(draft, detail.sourceDate, item.sourceUrl), "utf8");

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
      "User-Agent": "ZnojmoZa5MinutBot/0.1 (+https://znojmo-za-5-minut.pages.dev)"
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
      sourceUrl
    });
  });

  return [...items.values()].sort((a, b) => b.sourceDate.localeCompare(a.sourceDate));
}

function isPressReleaseCandidate(sourceUrl: string, title: string, sourceHost: string): boolean {
  const url = new URL(sourceUrl);
  const host = url.hostname.replace(/^www\./, "");
  const path = decodeURIComponent(url.pathname).toLowerCase();
  const combined = `${title} ${path}`.toLowerCase();

  if (host !== sourceHost || url.hash || !/\/d-\d+/.test(url.pathname)) {
    return false;
  }

  if (/zamer|záměr|pronajmu|pronájmu|prodej|uredni|úřední|deska|vyhlaska|vyhláška|verejna-vyhlaska|veřejná-vyhláška/.test(combined)) {
    return false;
  }

  return /radnic|sport|studii|studie|knih|pamat|památ|senior|skol|škol|dopr|festival|kultur|vystav|výstav|ocenen|oceněn|novink/.test(combined);
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
    text
  };
}

async function createDraftWithOpenAI(originalTitle: string, sourceDate: string, sourceText: string): Promise<ArticleDraft> {
  if (!client) {
    throw new Error("OpenAI client is not configured.");
  }

  const response = await client.responses.create({
    model: openAiModel,
    input: [
      {
        role: "system",
        content: [
          "Jsi zkušený český editor lokálního zpravodajství.",
          "Piš jako redaktor zpravodajského webu: jasně, věcně, česky, v krátkých odstavcích.",
          "Nepoužívej marketing, úřední jazyk ani AI fráze typu významný krok, komplexní informace, přibližuje novým způsobem, aktivní účast občanů.",
          "Nepřidávej hodnocení, spekulace ani obecné závěry. Neopisuj celé tiskové zprávy.",
          "Vracej pouze validní JSON."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          "Zpracuj tiskovou zprávu města Znojma do návrhu krátkého článku pro web Znojmo za 5 minut.",
          "Výstup musí být JSON s poli: title, slug, excerpt, body, answerQuestion, answerText, riskLevel.",
          "title piš jako novinový titulek pro běžné čtenáře, ne jako úřední název dokumentu.",
          "excerpt napiš jednou konkrétní větou bez prázdných slov.",
          "answerText napiš ve 2 až 3 krátkých větách.",
          "body napiš jako 3 až 5 krátkých odstavců. Každý odstavec má nést novou informaci.",
          "slug používej bez diakritiky, malými písmeny, oddělený pomlčkami.",
          "riskLevel nastav na low, medium nebo high podle toho, jak moc text vyžaduje lidské ověření.",
          "body vrať jako Markdown bez frontmatteru.",
          "Nepoužívej slova a obraty: komplexní, významný, přispělo k, je neodmyslitelnou součástí, obyvatelé mají šanci, v souladu s moderními požadavky.",
          "Pokud text není aktualita nebo tisková zpráva pro veřejnost, nastav riskLevel na high a titulkem naznač, že vyžaduje kontrolu.",
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
            excerpt: { type: "string" },
            body: { type: "string" },
            answerQuestion: { type: "string" },
            answerText: { type: "string" },
            riskLevel: { type: "string", enum: ["low", "medium", "high"] }
          },
          required: ["title", "slug", "excerpt", "body", "answerQuestion", "answerText", "riskLevel"]
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

function toMarkdown(draft: ArticleDraft, sourceDate: string, sourceUrl: string): string {
  const frontmatter = {
    title: draft.title,
    slug: draft.slug,
    date: today(),
    sourceName,
    sourceDate,
    sourceUrl,
    draft: true,
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

function hashText(value: string): string {
  return createHash("sha256").update(cleanText(value).toLowerCase()).digest("hex");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

# Znojmo za 5 minut

MVP statického webu v Astře, který publikuje schválené Markdown články a umí přes GitHub Actions vytvářet drafty z tiskových zpráv města Znojma.

## Lokální spuštění

```bash
npm install
npm run dev
```

## Scraper

Scraper je v `scripts/scrape-znojmo.ts` a spouští se:

```bash
npm run scrape:znojmo
```

Vyžaduje proměnné prostředí:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ZNOJMO_PRESS_SOURCE_URL`

Nové návrhy ukládá do `src/content/articles/` jako Markdown s `draft: true`. Zpracované položky eviduje v `data/seen.json` podle URL a hashe obsahu.

## Publikování článků

Veřejně se zobrazují jen články s:

```yaml
draft: false
```

URL zdroje může být uložená ve frontmatteru jako `sourceUrl`, ale web ji veřejně nezobrazuje.

## Cloudflare Pages

- Build command: `npm run build`
- Output directory: `dist`

GitHub Actions workflow je v `.github/workflows/scrape-znojmo.yml` a podporuje ruční i plánované spuštění.

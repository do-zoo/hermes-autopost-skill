# Article format

Each draft is a plain text file: front matter, then markdown.

```
---
title: Judul artikel yang jelas dan spesifik
excerpt: Ringkasan 1-2 kalimat (30-400 karakter).
meta_description: Deskripsi SEO 50-170 karakter.
---
Paragraf pembuka...

## Subjudul pertama

Isi...

## Subjudul kedua

Isi...
```

## Rules (enforced by `submit`)

- Title 10-120 chars; excerpt 30-400; meta_description 50-170. The slug is generated from the title.
- Minimum words: `minWords` (main) and 70% of it (English). The `next` output states the numbers.
- At least two `##` sections. Use only `##`, `###`, `####`.
- Allowed: paragraphs, **bold**, *italic*, bullet/numbered lists, `> quotes`, `inline code`, fenced code, `---`.
- Not allowed: `#` title in the body, tables, inline HTML, images, placeholders, AI self-reference, `<think>` blocks.
- Links only when the site has `research: true`, and only to URLs you actually fetched.
- English draft: same structure, complete (title, excerpt, meta_description, body). The backend rejects partial English.

## Style

Open with the point, not with filler. Concrete steps and examples over generalities. Match `tone` and `audience` from the site config.

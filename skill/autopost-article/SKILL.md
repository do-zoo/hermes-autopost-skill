---
name: autopost-article
description: Plan topics, write articles and submit them as drafts to the user's own Next.js sites (Inget Gue backoffice) through a deterministic toolbox script. Use for scheduled autoposting runs or when asked to write/queue articles for a configured site.
version: 1.0.0
author: Edwar
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [content, publishing, autopost]
    category: content
required_environment_variables:
  - name: INGET_HERMES_TOKEN
    prompt: Inget Gue API token (igt_...) for the hermes ContentBot user
    help: Account > API Tokens in the backoffice. Scopes posts:read + posts:create only.
---

# Autopost Article

You write; a script does everything with side effects. Never call the site API yourself, never
edit planner files by hand, never print or store tokens. Articles are created as **drafts**; a human publishes.

## When to Use

- A scheduled run whose prompt says sites need work (the precheck output lists them).
- The user asks to queue or write articles for a configured site.

## Quick Reference

All commands: `node ${HERMES_SKILL_DIR}/scripts/autopost.mjs <command>`

| Command | Purpose |
|---|---|
| `status [--site S]` | Backlog, counts, items with errors |
| `context --site S` | Niche, allowed categories, existing titles, how many topics are needed |
| `plan-add --site S --file F` | Validate (category, duplicates) and schedule proposed topics |
| `next --site S` | Claim the next due item; returns draft paths and format rules |
| `submit --site S --item ID` | Run quality gates, send to the site, update status |

## Procedure

1. **Triage.** Sites to handle come from the run prompt. If none are named, run `status`.
2. **Top up topics** (only if `context` says `need > 0`):
   - Run `context --site S`. Pick up to `need` fresh topics that fit niche and audience.
   - Use only category slugs from `categories`. Avoid anything close to `existingTitles`.
   - Write them to a scratch file as `{"items":[{"topic","angle","keywords","category"}]}` and run `plan-add`.
     Rejected items are reported with reasons; do not retry them unchanged.
3. **Write due articles.** Repeat up to `site.postsPerRun` times:
   - `next --site S`. If `item` is null, stop.
   - Write the main draft (Indonesian) to `drafts.id.path`. If `drafts.en` is present, write a complete English
     version to `drafts.en.path` (translation of the whole article, not a summary).
     If a draft already has `exists: true` (a retry after a network failure), do **not** rewrite it; just submit.
   - Format: see `references/article-format.md`. Front matter with `title`, `excerpt`, `meta_description`, then markdown.
   - `submit --site S --item ID`.
4. **Handle the result** (exit code, with JSON on stdout):

| Exit | `result` | What to do |
|---|---|---|
| 0 | `published` | Done. The draft is in the backoffice. |
| 10 | `revise` | Read `problems`, fix the draft file(s) in place, submit again. Max attempts are enforced by the script. |
| 20 | `deferred` | Network/server issue. Nothing to fix; the script retries in 1h. Stop this site for this run. |
| 30 | `blocked` | Token/config problem. Stop this site, report it. Do not retry. |
| 30 | `failed` | Needs a human (gave up, or the post already exists). Move on to the next item. |

5. **Report** in the exact format from the run prompt. If nothing was done, reply with exactly `[SILENT]`.

## Pitfalls

- Do not invent statistics, quotes, names or URLs. If a fact is not common knowledge, leave it out. Sites with
  `research: false` reject all links.
- Do not paste the article into the chat or the report; only titles and ids.
- One `next` at a time per site. Never run two submits for the same item.
- `revise` means edit the existing file, not start a new topic.
- Do not create categories or modify `sites.json`; ask the user.

## Verification

After a run, `status --site S` should show the item as `published` (or a clear `lastError`), and the backlog
should not have dropped below zero or grown past the target.

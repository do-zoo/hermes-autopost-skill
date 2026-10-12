#!/usr/bin/env node
// autopost.mjs — deterministic toolbox for the `autopost-article` Hermes skill.
// Zero dependencies, Node >= 18. The agent decides WHAT to write; this script owns every side effect:
// planner state, validation, calling the Inget Gue adapter, status transitions.
//
// Agent-facing exit codes of `submit`: 0 done, 10 revise, 20 deferred, 30 needs human.
// Other commands: 0 ok, 1 config/usage/auth error, 20 network error.

import { execFile } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync, readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOUR = 3600_000;
const STALE_WRITING_MS = 30 * 60_000;
const BLOCKED_BACKOFF_MS = 6 * HOUR;
const ADAPTER_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- paths / config

// Profile-safe: cron/terminal children may not inherit HERMES_HOME, so fall back to the location of this
// script ($HERMES_HOME/skills/<name>/scripts/autopost.mjs) before the default ~/.hermes.
function resolveHermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const here = dirname(fileURLToPath(import.meta.url)).split(/[\\/]/);
  const i = here.lastIndexOf("skills");
  if (i > 0) return here.slice(0, i).join("/") || "/";
  return join(homedir(), ".hermes");
}
const HERMES_HOME = resolveHermesHome();
const HOME_DIR = process.env.AUTOPOST_HOME || join(HERMES_HOME, "autopost");
const SITES_FILE = process.env.AUTOPOST_SITES || join(HOME_DIR, "sites.json");

class Fail extends Error {
  constructor(msg, code = 1) { super(msg); this.code = code; }
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function loadSites() {
  if (!existsSync(SITES_FILE)) throw new Fail(`sites file not found: ${SITES_FILE}`);
  let raw;
  try { raw = JSON.parse(readFileSync(SITES_FILE, "utf8")); }
  catch (e) { throw new Fail(`sites file is not valid JSON: ${e.message}`); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Fail("sites file must be a non-empty array");
  return raw.map((s) => {
    if (!s.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(s.id)) throw new Fail(`invalid site id: ${s.id}`);
    if (!s.apiUrl) throw new Fail(`site ${s.id}: apiUrl missing`);
    if (!s.adapterDir) throw new Fail(`site ${s.id}: adapterDir missing`);
    const target = s.planBacklogTarget ?? 14;
    return {
      apiKeyEnv: "INGET_HERMES_TOKEN",
      adapterCommand: ["npx", "tsx", "post-article.ts"],
      niche: "", audience: "", tone: "informative, practical",
      bilingual: false, research: false,
      postsPerRun: 1, cadenceHours: 24, minWords: 600, maxAttempts: 3,
      ...s,
      apiUrl: String(s.apiUrl).replace(/\/+$/, ""),
      planBacklogTarget: target,
      planRefillBelow: s.planRefillBelow ?? Math.ceil(target / 2),
    };
  });
}

function pickSites(args) {
  const all = loadSites();
  if (!args.site) return all;
  const s = all.find((x) => x.id === args.site);
  if (!s) throw new Fail(`unknown site: ${args.site} (known: ${all.map((x) => x.id).join(", ")})`);
  return [s];
}

function oneSite(args) {
  if (!args.site) throw new Fail("--site is required");
  return pickSites(args)[0];
}

const token = (site) => {
  const t = process.env[site.apiKeyEnv];
  if (!t) throw new Fail(`env ${site.apiKeyEnv} is not set (site ${site.id})`);
  return t;
};

// ---------------------------------------------------------------- planner store (JSON + lock)

const planFile = (id) => join(HOME_DIR, "plans", `${id}.json`);
const draftDir = (id) => join(HOME_DIR, "drafts", id);
const outFile = (site, item) => join(HOME_DIR, "out", site, `${item}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPlan(id) {
  const f = planFile(id);
  if (!existsSync(f)) return { items: [] };
  return JSON.parse(readFileSync(f, "utf8"));
}

function writePlan(id, plan) {
  const f = planFile(id);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(tmp, f);
}

/** Short critical sections only. Never held across network or adapter calls. */
async function withLock(id, fn) {
  const dir = `${planFile(id)}.lock`;
  mkdirSync(dirname(dir), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(dir).mtimeMs > 30_000) rmSync(dir, { recursive: true, force: true }); } catch { /* raced */ }
      if (Date.now() - t0 > 15_000) throw new Fail(`could not lock planner for ${id}`);
      await sleep(50);
    }
  }
  try {
    const plan = readPlan(id);
    const res = await fn(plan);
    writePlan(id, plan);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const iso = (ms) => new Date(ms).toISOString();

function isStale(it, now) {
  return it.status === "writing" && now - Date.parse(it.claimedAt || 0) > STALE_WRITING_MS;
}

function summarize(site, plan, now = Date.now()) {
  const items = plan.items;
  const backlog = items.filter((i) => i.status === "pending" || i.status === "writing").length;
  const due = items.filter((i) => (i.status === "pending" && Date.parse(i.scheduledFor) <= now) || isStale(i, now)).length;
  const needsTopics = backlog < site.planRefillBelow ? Math.max(0, site.planBacklogTarget - backlog) : 0;
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  return { due, backlog, needsTopics, counts };
}

// ---------------------------------------------------------------- Inget Gue API (read side)

async function api(site, path) {
  let res;
  try {
    res = await fetch(`${site.apiUrl}${path}`, {
      headers: { authorization: `Bearer ${token(site)}`, accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Fail(`network error calling ${path}: ${e.message}`, 20);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Fail(`API rejected the token (${res.status}) on ${path}; needs scopes posts:read + posts:create`, 1);
  }
  if (!res.ok) throw new Fail(`API ${res.status} on ${path}`, res.status >= 500 || res.status === 429 ? 20 : 1);
  return res.json();
}

async function fetchCategories(site) {
  const j = await api(site, "/api/posts/categories");
  const p = j?.data;
  const list = Array.isArray(p) ? p : (p?.data ?? []);
  return list
    .map((c) => ({ slug: c.slugEn || c.slugId || "", name: c.nameId || "" }))
    .filter((c) => c.slug);
}

async function fetchTitles(site) {
  try {
    const j = await api(site, "/api/posts?page=1&limit=100");
    return (j?.data?.data ?? []).map((p) => p.titleId).filter(Boolean);
  } catch (e) {
    if (e.code === 1) throw e; // auth problems must surface
    return []; // dedupe is best-effort
  }
}

// ---------------------------------------------------------------- dedupe

const tokens = (s) => new Set(
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2),
);

function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const isDuplicate = (topic, existing) => existing.some((e) => similarity(topic, e) >= 0.6);

// ---------------------------------------------------------------- article parsing + gates

export function slugify(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;

function parseArticle(raw) {
  let text = raw.trim();
  const fenced = text.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced) text = fenced[1].trim();
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error("front matter (--- ... ---) not found at the top of the file");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  const v = {
    title: meta.title ?? "", slug: slugify(meta.title ?? ""),
    excerpt: meta.excerpt ?? "", metaDescription: meta.meta_description ?? "", body: m[2].trim(),
  };
  const bad = [];
  if (v.title.length < 10 || v.title.length > 120) bad.push("title must be 10-120 chars");
  if (v.slug.length < 3) bad.push("title yields no usable slug");
  if (v.excerpt.length < 30 || v.excerpt.length > 400) bad.push("excerpt must be 30-400 chars");
  if (v.metaDescription.length < 50 || v.metaDescription.length > 170) bad.push("meta_description must be 50-170 chars");
  if (!v.body) bad.push("empty body");
  if (bad.length) throw new Error(`invalid metadata: ${bad.join("; ")}`);
  return v;
}

/**
 * The backend silently keeps only: p br h2 h3 h4 strong em u s blockquote ul ol li a img hr code pre.
 * Anything else is rejected here instead of vanishing in production.
 */
function qualityProblems(v, minWords, research) {
  const problems = [];
  const body = v.body;
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const words = wordCount(body);
  if (words < minWords) problems.push(`too short (${words} words, minimum ${minWords})`);
  if ((prose.match(/^## /gm) ?? []).length < 2) problems.push("fewer than 2 H2 sections");
  if (/^#\s/m.test(prose) || /^#{5,6}\s/m.test(prose)) problems.push("uses H1/H5/H6 (only H2-H4 are supported)");
  if (/^\s*\|.*\|\s*$/m.test(prose)) problems.push("uses a markdown table (unsupported)");
  if (/<\/?[a-z][^>]*>/i.test(prose)) problems.push("contains inline HTML");
  if (/!\[[^\]]*\]\(/.test(prose)) problems.push("contains an image");
  if (!research && /\[[^\]]+\]\([^)]*\)/.test(prose)) {
    problems.push("contains a link (research is off for this site, so any URL would be invented)");
  }
  if (/lorem ipsum|\bTODO\b|\bTBD\b|\[insert|\[masukkan|\{\{/i.test(body)) problems.push("contains a placeholder");
  if (/sebagai (sebuah )?(model )?(ai|kecerdasan buatan)|as an ai\b|as a language model/i.test(body)) problems.push("contains AI meta-commentary");
  if (/<think>/i.test(body)) problems.push("contains a <think> block");
  return problems;
}

// ---------------------------------------------------------------- adapter call

const EXISTS_RE = /already exists \(id ([^,)]+), slug ([^)]+)\)/;

function runAdapter(site, file) {
  const [cmd, ...cmdArgs] = site.adapterCommand;
  return new Promise((done) => {
    execFile(
      cmd, [...cmdArgs, resolve(file)],
      {
        cwd: site.adapterDir, timeout: ADAPTER_TIMEOUT_MS, maxBuffer: 1024 * 1024,
        // Minimal env: no other site's token and no model keys reach the child process.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, INGET_API_URL: site.apiUrl, INGET_API_TOKEN: token(site) },
      },
      (err, stdout, stderr) => {
        if (!err) return done({ kind: "exit", code: 0, stdout, stderr });
        if (err.killed) return done({ kind: "timeout" });
        if (typeof err.code === "number") return done({ kind: "exit", code: err.code, stdout, stderr });
        done({ kind: "spawn", message: err.message });
      },
    );
  });
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[k] = true;
      else { a[k] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

// ---------------------------------------------------------------- commands

async function cmdPrecheck(args) {
  let sites;
  try { sites = pickSites(args); }
  catch (e) {
    // Config errors must reach a human: wake the agent so it reports them.
    console.log(`autopost config problem: ${e.message}`);
    return;
  }
  const now = Date.now();
  const lines = [];
  for (const s of sites) {
    const sum = summarize(s, readPlan(s.id), now);
    if (sum.due > 0 || sum.needsTopics > 0) {
      lines.push(`- ${s.id}: due=${sum.due}, backlog=${sum.backlog}/${s.planBacklogTarget}, needs_topics=${sum.needsTopics}`);
    }
  }
  if (lines.length === 0) console.log(JSON.stringify({ wakeAgent: false }));
  else console.log(`Sites needing work:\n${lines.join("\n")}`);
}

async function cmdContext(args) {
  const site = oneSite(args);
  const categories = await fetchCategories(site);
  if (categories.length === 0) throw new Fail(`site ${site.id} has no categories; create one in the backoffice first`);
  const titles = await fetchTitles(site);
  const plan = readPlan(site.id);
  const planned = plan.items.filter((i) => i.status !== "failed").map((i) => i.topic);
  const sum = summarize(site, plan);
  out({
    site: site.id, today: iso(Date.now()).slice(0, 10),
    niche: site.niche, audience: site.audience, tone: site.tone, bilingual: site.bilingual, research: site.research,
    need: sum.needsTopics, backlog: sum.backlog, target: site.planBacklogTarget,
    categories, existingTitles: [...new Set([...titles, ...planned])],
    planFileFormat: { items: [{ topic: "string (>=8 chars)", angle: "string", keywords: ["string"], category: "slug from categories" }] },
  });
}

async function cmdPlanAdd(args) {
  const site = oneSite(args);
  if (!args.file) throw new Fail("--file is required");
  let input;
  try { input = JSON.parse(readFileSync(args.file, "utf8")); }
  catch (e) { throw new Fail(`cannot read plan file: ${e.message}`); }
  const proposed = Array.isArray(input) ? input : input.items;
  if (!Array.isArray(proposed) || proposed.length === 0) throw new Fail("plan file needs a non-empty `items` array");

  const categories = new Set((await fetchCategories(site)).map((c) => c.slug));
  const titles = await fetchTitles(site);

  const result = await withLock(site.id, (plan) => {
    const sum = summarize(site, plan);
    let room = Math.max(0, site.planBacklogTarget - sum.backlog);
    const existing = [...titles, ...plan.items.filter((i) => i.status !== "failed").map((i) => i.topic)];
    const accepted = [], rejected = [];
    for (const it of proposed) {
      const topic = String(it?.topic ?? "").trim();
      if (topic.length < 8) { rejected.push({ topic, reason: "topic too short" }); continue; }
      if (!categories.has(it.category)) { rejected.push({ topic, reason: `unknown category "${it.category}"` }); continue; }
      if (room <= 0) { rejected.push({ topic, reason: "backlog target reached" }); continue; }
      if (isDuplicate(topic, [...existing, ...accepted.map((a) => a.topic)])) { rejected.push({ topic, reason: "duplicate of an existing or planned title" }); continue; }
      accepted.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        topic, angle: String(it.angle ?? ""), keywords: Array.isArray(it.keywords) ? it.keywords.map(String) : [],
        category: it.category, status: "pending", attempts: 0, lastError: "", remoteRef: "",
      });
      room--;
    }
    const cadence = site.cadenceHours * HOUR;
    const live = plan.items.filter((i) => i.status !== "failed").map((i) => Date.parse(i.scheduledFor)).filter(Number.isFinite);
    const last = live.length ? Math.max(...live) : null;
    const start = last ? Math.max(last + cadence, Date.now()) : Date.now();
    accepted.forEach((a, i) => { a.scheduledFor = iso(start + i * cadence); });
    plan.items.push(...accepted);
    return { accepted, rejected };
  });

  out({
    added: result.accepted.length,
    scheduled: result.accepted.map((a) => ({ id: a.id, topic: a.topic, category: a.category, scheduledFor: a.scheduledFor })),
    rejected: result.rejected,
  });
}

function itemPayload(site, it) {
  const dir = draftDir(site.id);
  const idPath = join(dir, `${it.id}.id.md`);
  const enPath = join(dir, `${it.id}.en.md`);
  return {
    id: it.id, topic: it.topic, angle: it.angle, keywords: it.keywords, category: it.category,
    attempts: it.attempts, lastError: it.lastError || undefined,
    drafts: { id: { path: idPath, exists: existsSync(idPath) }, ...(site.bilingual ? { en: { path: enPath, exists: existsSync(enPath) } } : {}) },
  };
}

async function cmdNext(args) {
  const site = oneSite(args);
  const claimed = await withLock(site.id, (plan) => {
    const now = Date.now();
    const cand = plan.items
      .filter((i) => (i.status === "pending" && Date.parse(i.scheduledFor) <= now) || isStale(i, now))
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
    if (!cand) return null;
    cand.status = "writing";
    cand.claimedAt = iso(now);
    return { ...cand };
  });
  if (!claimed) return out({ item: null });
  mkdirSync(draftDir(site.id), { recursive: true });
  out({
    item: itemPayload(site, claimed),
    format: {
      file: "front matter + markdown body, written to each draft path",
      frontMatter: ["title (10-120 chars)", "excerpt (30-400 chars)", "meta_description (50-170 chars)"],
      allowedMarkdown: "## ### #### headings, paragraphs, **bold**, *italic*, lists, > quotes, `code`, fenced code, ---",
      forbidden: ["H1 (# )", "H5/H6", "tables", "inline HTML", "images", site.research ? null : "links"].filter(Boolean),
      minWords: site.minWords, minWordsEn: Math.floor(site.minWords * 0.7),
      language: "Indonesian for the main draft" + (site.bilingual ? "; the .en draft is a full English version (not a summary)" : ""),
    },
    site: { niche: site.niche, audience: site.audience, tone: site.tone, bilingual: site.bilingual, research: site.research, postsPerRun: site.postsPerRun },
  });
}

async function patchItem(siteId, itemId, fn) {
  return withLock(siteId, (plan) => {
    const it = plan.items.find((i) => i.id === itemId);
    if (!it) throw new Fail(`unknown item: ${itemId}`);
    fn(it);
    return { ...it };
  });
}

const trunc = (s) => String(s).slice(0, 500);

async function cmdSubmit(args) {
  const site = oneSite(args);
  if (!args.item) throw new Fail("--item is required");
  const dir = draftDir(site.id);
  const idFile = args["id-file"] || join(dir, `${args.item}.id.md`);
  const enFile = args["en-file"] || join(dir, `${args.item}.en.md`);

  const plan0 = readPlan(site.id);
  const item = plan0.items.find((i) => i.id === args.item);
  if (!item) throw new Fail(`unknown item: ${args.item}`);
  if (item.status === "published") { out({ result: "already-published", remoteRef: item.remoteRef }); return 0; }
  if (item.status === "failed") { out({ result: "failed", message: "item already failed; needs a human" }); return 30; }

  // ---- gates (a gate failure costs one attempt; the agent revises the same files)
  const problems = [];
  let idV, enV;
  if (!existsSync(idFile)) problems.push(`main draft not found: ${idFile}`);
  else {
    try {
      idV = parseArticle(readFileSync(idFile, "utf8"));
      problems.push(...qualityProblems(idV, site.minWords, site.research));
    } catch (e) { problems.push(`main draft: ${e.message}`); }
  }
  if (site.bilingual) {
    if (!existsSync(enFile)) problems.push(`English draft not found: ${enFile} (this site is bilingual)`);
    else {
      try {
        enV = parseArticle(readFileSync(enFile, "utf8"));
        problems.push(...qualityProblems(enV, Math.floor(site.minWords * 0.7), site.research).map((p) => `English draft: ${p}`));
      } catch (e) { problems.push(`English draft: ${e.message}`); }
    }
  }
  if (problems.length) return reviseOrFail(site, item, problems, "gates");

  // ---- build adapter input
  const file = {
    category: item.category,
    titleId: idV.title, slugId: idV.slug, excerptId: idV.excerpt, contentId: idV.body, seoDescriptionId: idV.metaDescription,
    ...(enV ? { titleEn: enV.title, slugEn: enV.slug, excerptEn: enV.excerpt, contentEn: enV.body, seoDescriptionEn: enV.metaDescription } : {}),
  };
  const of = outFile(site.id, item.id);
  mkdirSync(dirname(of), { recursive: true });
  writeFileSync(of, `${JSON.stringify(file, null, 2)}\n`);

  if (args["dry-run"]) {
    await patchItem(site.id, item.id, (it) => { it.status = "pending"; });
    out({ result: "dry-run", file: of, message: "gates passed; nothing sent; item stays pending" });
    return 0;
  }

  // ---- send (no lock held)
  const r = await runAdapter(site, of);

  if (r.kind === "timeout") return defer(site, item, `adapter did not finish within ${ADAPTER_TIMEOUT_MS / 1000}s`);
  if (r.kind === "spawn") return block(site, item, `adapter cannot be started: ${r.message}`);

  if (r.code === 0) {
    const last = r.stdout.trim().split("\n").pop() ?? "";
    let id = "unknown", status = "";
    try { const j = JSON.parse(last); id = String(j.id ?? "unknown"); status = j.status ?? ""; } catch { /* exit 0 means created */ }
    await patchItem(site.id, item.id, (it) => { it.status = "published"; it.remoteRef = id; it.lastError = ""; it.publishedAt = iso(Date.now()); });
    out({ result: "published", postId: id, status, title: idV.title, message: "draft created in the backoffice" });
    return 0;
  }

  const msg = trunc((r.stderr || r.stdout).trim() || `exit ${r.code}`);
  if (r.code === 4) return defer(site, item, msg);
  if (r.code === 1 || r.code === 2) return block(site, item, msg);
  if (r.code === 3) {
    const m = EXISTS_RE.exec(msg);
    if (m) {
      await patchItem(site.id, item.id, (it) => { it.status = "failed"; it.lastError = `post already exists (id ${m[1]}, slug ${m[2]}); check the backoffice`; });
      out({ result: "failed", message: `A post already exists (id ${m[1]}, slug ${m[2]}). It may be a collision or an earlier send that actually landed. A human must check.` });
      return 30;
    }
    rmSync(of, { force: true });
    return reviseOrFail(site, item, [`backend rejected the article: ${msg}`], "backend");
  }
  return block(site, item, `unexpected adapter exit ${r.code}: ${msg}`);
}

async function reviseOrFail(site, item, problems, source) {
  const msg = trunc(problems.join("; "));
  const now = await patchItem(site.id, item.id, (it) => {
    it.attempts += 1;
    it.lastError = msg;
    it.claimedAt = iso(Date.now());
    it.status = it.attempts >= site.maxAttempts ? "failed" : "writing";
  });
  if (now.status === "failed") {
    out({ result: "failed", source, problems, message: `giving up after ${now.attempts} attempts; needs a human` });
    return 30;
  }
  out({ result: "revise", source, problems, attemptsLeft: site.maxAttempts - now.attempts, message: "fix the draft file(s) in place and run submit again" });
  return 10;
}

async function defer(site, item, msg) {
  await patchItem(site.id, item.id, (it) => { it.status = "pending"; it.lastError = trunc(msg); it.scheduledFor = iso(Date.now() + HOUR); });
  out({ result: "deferred", message: `network/server problem, retry scheduled in 1h; the draft is kept and will be resent without rewriting. ${trunc(msg)}` });
  return 20;
}

async function block(site, item, msg) {
  await patchItem(site.id, item.id, (it) => { it.status = "pending"; it.lastError = trunc(msg); it.scheduledFor = iso(Date.now() + BLOCKED_BACKOFF_MS); });
  out({ result: "blocked", abortRun: true, message: `token/config problem (not the article): ${trunc(msg)}. Stop work on this site and report it to the user.` });
  return 30;
}

async function cmdStatus(args) {
  const rows = pickSites(args).map((s) => {
    const plan = readPlan(s.id);
    const sum = summarize(s, plan);
    const next = plan.items.filter((i) => i.status === "pending").sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
    return {
      site: s.id, ...sum, nextScheduled: next?.scheduledFor ?? null,
      problems: plan.items.filter((i) => i.status === "failed" || (i.lastError && i.status !== "published"))
        .map((i) => ({ id: i.id, topic: i.topic, status: i.status, lastError: i.lastError })),
    };
  });
  out(rows);
}

// ---------------------------------------------------------------- main

const HELP = `autopost.mjs <command> [options]
  precheck [--site S]
  context  --site S
  plan-add --site S --file plan.json
  next     --site S
  submit   --site S --item ID [--id-file F] [--en-file F] [--dry-run]
  status   [--site S]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case "precheck": return cmdPrecheck(args);
    case "context": return cmdContext(args);
    case "plan-add": return cmdPlanAdd(args);
    case "next": return cmdNext(args);
    case "submit": return cmdSubmit(args);
    case "status": return cmdStatus(args);
    default: console.error(HELP); return 1;
  }
}

main().then(
  (code) => process.exit(typeof code === "number" ? code : 0),
  (e) => {
    if (e instanceof Fail) {
      console.error(JSON.stringify({ error: e.message }));
      process.exit(e.code);
    }
    console.error(`unexpected error: ${e?.stack || e}`);
    process.exit(1);
  },
);

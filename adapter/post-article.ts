#!/usr/bin/env -S npx tsx
/**
 * Creates (or with --update, edits) a blog post through the Inget Gue API using an API token (ADR 0004).
 *
 *   INGET_API_URL=http://localhost:3002 INGET_API_TOKEN=igt_... \
 *     tsx post-article.ts article.json [--cover cover.jpg] [--publish] [--update]
 *
 * Exit codes: 0 ok, 1 usage/config, 2 auth, 3 validation/conflict, 4 network/server (retried).
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';

export const EXIT = { OK: 0, USAGE: 1, AUTH: 2, INVALID: 3, NETWORK: 4 } as const;

export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
export interface Deps {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<Buffer>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

const MARKDOWN_FIELDS = ['contentId', 'contentEn'] as const;
const PASSTHROUGH = [
  'titleId',
  'slugId',
  'excerptId',
  'contentId',
  'seoTitleId',
  'seoDescriptionId',
  'titleEn',
  'slugEn',
  'excerptEn',
  'contentEn',
  'seoTitleEn',
  'seoDescriptionEn',
  'seoOgImageUrl',
  'seoRobotsIndex',
] as const;
const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const RETRIES = 3;

export function parseArgs(argv: string[]) {
  const opts = { file: '', cover: '', publish: false, update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--cover') opts.cover = argv[++i] ?? '';
    else if (a === '--publish') opts.publish = true;
    else if (a === '--update') opts.update = true;
    else if (a.startsWith('--')) throw new CliError(EXIT.USAGE, `Unknown option ${a}`);
    else opts.file = a;
  }
  if (!opts.file)
    throw new CliError(
      EXIT.USAGE,
      'Usage: post-article <article.json> [--cover img] [--publish] [--update]'
    );
  return opts;
}

export function toHtml(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/** The HTML tags the backend keeps; anything else is silently dropped by its sanitizer. */
export function buildBody(article: Json): Json {
  const body: Json = {};
  for (const key of PASSTHROUGH) if (article[key] != null) body[key] = article[key];
  for (const key of MARKDOWN_FIELDS)
    if (typeof body[key] === 'string') body[key] = toHtml(body[key] as string);
  return body;
}

type Category = { id: string; nameId: string; nameEn: string; slugId: string; slugEn: string };

export function pickCategory(categories: Category[], wanted: string): Category {
  const w = wanted.trim().toLowerCase();
  const hit = categories.find((c) =>
    [c.nameId, c.nameEn, c.slugId, c.slugEn].some((v) => v?.toLowerCase() === w)
  );
  if (!hit) {
    const names = categories.map((c) => c.slugEn || c.slugId).join(', ');
    throw new CliError(EXIT.INVALID, `Category "${wanted}" not found. Available: ${names}`);
  }
  return hit;
}

function failureFor(status: number, message: string): CliError {
  if (status === 401 || status === 403)
    return new CliError(EXIT.AUTH, `Auth failed (${status}): ${message}`);
  if (status === 429 || status >= 500)
    return new CliError(EXIT.NETWORK, `Server error (${status}): ${message}`);
  return new CliError(EXIT.INVALID, `Rejected (${status}): ${message}`);
}

function makeClient(env: Record<string, string | undefined>, deps: Deps) {
  const base = env.INGET_API_URL?.replace(/\/+$/, '');
  const token = env.INGET_API_TOKEN;
  if (!base || !token) throw new CliError(EXIT.USAGE, 'Set INGET_API_URL and INGET_API_TOKEN');

  return async function call(
    method: string,
    path: string,
    body?: Json | FormData
  ): Promise<{ status: number; data: any }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await deps.fetch(base + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body && !(body instanceof FormData) && { 'Content-Type': 'application/json' }),
          },
          body: body instanceof FormData ? body : body && JSON.stringify(body),
        });
        const json: any = await res.json().catch(() => ({}));
        if (res.ok) return { status: res.status, data: json.data };
        const err = failureFor(res.status, json?.error?.message ?? res.statusText);
        if (err.exitCode !== EXIT.NETWORK || attempt >= RETRIES)
          throw Object.assign(err, { status: res.status });
      } catch (e) {
        if (e instanceof CliError && e.exitCode !== EXIT.NETWORK) throw e;
        if (attempt >= RETRIES)
          throw e instanceof CliError
            ? e
            : new CliError(EXIT.NETWORK, `Network error: ${(e as Error).message}`);
      }
      await deps.sleep(1000 * 2 ** (attempt - 1));
    }
  };
}

async function findPost(call: ReturnType<typeof makeClient>, body: Json) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await call('GET', `/api/posts?page=${page}&limit=100`);
    const hit = (data.data as Json[]).find((p) =>
      body.slugId ? p.slugId === body.slugId : p.titleId === body.titleId
    );
    if (hit) return hit;
    if (page >= data.meta.totalPages) return null;
  }
  return null;
}

export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: Deps
): Promise<Json> {
  const opts = parseArgs(argv);
  const call = makeClient(env, deps);

  let article: Json;
  try {
    article = JSON.parse((await deps.readFile(opts.file)).toString('utf8'));
  } catch (e) {
    throw new CliError(EXIT.USAGE, `Cannot read ${opts.file}: ${(e as Error).message}`);
  }
  const upload = async (path: string): Promise<string> => {
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!type) throw new CliError(EXIT.USAGE, `Unsupported image type: ${path}`);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(await deps.readFile(path))], { type }),
      basename(path)
    );
    return (await call('POST', '/api/media/upload', form)).data.url;
  };

  // Local image paths in the markdown (relative to the article file) are uploaded and replaced by their URL.
  const uploaded = new Map<string, string>();
  for (const key of MARKDOWN_FIELDS) {
    const md = article[key];
    if (typeof md !== 'string') continue;
    const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
    let out = '';
    let last = 0;
    for (const m of md.matchAll(re)) {
      const src = m[2]!;
      out += md.slice(last, m.index);
      last = m.index + m[0].length;
      if (/^(https?:|data:)/i.test(src)) {
        out += m[0];
        continue;
      }
      const file = resolve(dirname(opts.file), src);
      if (!uploaded.has(file)) uploaded.set(file, await upload(file));
      out += `![${m[1]}](${uploaded.get(file)})`;
    }
    article[key] = out + md.slice(last);
  }
  const body = buildBody(article);

  const wanted = (article.category ?? article.categoryId) as string | undefined;
  if (!wanted) throw new CliError(EXIT.INVALID, 'Article needs "category" (name or slug)');
  const { data: cats } = await call('GET', '/api/posts/categories');
  body.categoryId = pickCategory(Array.isArray(cats) ? cats : cats.data, wanted).id;

  if (opts.cover) {
    body.coverImageUrl = /^https?:\/\//i.test(opts.cover) ? opts.cover : await upload(opts.cover);
  }

  const createBody = { ...body };
  if (opts.publish) {
    assertCover(createBody, {});
    Object.assign(createBody, publishFields(deps));
  }
  const created = await call('POST', '/api/posts', createBody).catch(async (e) => {
    if (!(e instanceof CliError) || (e as { status?: number }).status !== 409) throw e;
    const existing = await findPost(call, body);
    if (!existing) throw e;
    if (!opts.update) {
      throw new CliError(
        EXIT.INVALID,
        `Post already exists (id ${existing.id}, slug ${existing.slugId}); use --update to overwrite`
      );
    }
    return { status: 200, data: { __existing: existing } };
  });

  let post = created.data;
  if (post.__existing) {
    const existing = post.__existing as Json;
    if (opts.publish) {
      assertCover(body, existing);
      Object.assign(body, publishFields(deps));
    }
    post = (await call('PUT', `/api/posts/${existing.id}`, body)).data;
  }
  return {
    id: post.id,
    status: post.status,
    slugId: post.slugId,
    slugEn: post.slugEn ?? null,
    coverImageUrl: post.coverImageUrl ?? null,
  };
}

const publishFields = (deps: Deps) => ({ status: 'ACTIVE', publishedAt: deps.now().toISOString() });

function assertCover(body: Json, existing: Json) {
  if (!body.coverImageUrl && !existing.coverImageUrl) {
    throw new CliError(
      EXIT.INVALID,
      'Refusing to publish without a cover image; pass --cover or publish later from the backoffice'
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2), process.env, {
    fetch,
    readFile,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  })
    .then((out) => console.log(JSON.stringify(out)))
    .catch((e) => {
      console.error(e instanceof CliError ? e.message : e);
      process.exit(e instanceof CliError ? e.exitCode : EXIT.NETWORK);
    });
}

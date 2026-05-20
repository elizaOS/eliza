#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";

/**
 * Fetch Elysia documentation into local markdown files using Bun/TypeScript.
 *
 * Strategy:
 * - Read the public VitePress hashmap at https://elysiajs.com/hashmap.json to discover pages.
 * - Skip blog/playground/4koma.
 * - Try to download the `.md` source for each page.
 * - If `.md` is missing, fall back to HTML and do a lightweight HTML -> markdown pass.
 *
 * Usage:
 *   bun run scripts/pull_elysia_docs.ts [--base-url https://elysiajs.com] [--output elysia] [--workers 16]
 */

const BASE_URL = "https://elysiajs.com";
const HASHMAP_PATH = "/hashmap.json";
const DEFAULT_OUTPUT = "elysia";
const DEFAULT_WORKERS = 16;

const SKIP_SUFFIXES = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".json",
  ".map",
  ".woff",
  ".woff2",
];

type Page = {
  key: string;
  path: string; // path without .md, eg: essential/handler
  output: string; // filesystem path
};

type Options = {
  baseUrl: string;
  output: string;
  workers: number;
};

const args = Bun.argv.slice(2);
const opts: Options = {
  baseUrl: getArg("--base-url", BASE_URL),
  output: getArg("--output", DEFAULT_OUTPUT),
  workers: Number(getArg("--workers", String(DEFAULT_WORKERS))),
};

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

function keyToPage(key: string, outputRoot: string): Page | null {
  if (SKIP_SUFFIXES.some((s) => key.endsWith(s))) return null;

  const name = key.endsWith(".md") ? key.slice(0, -3) : key;
  const lowered = name.toLowerCase();
  if (
    lowered.startsWith("blog") ||
    lowered.includes("blog_") ||
    lowered.includes("4koma") ||
    lowered.includes("playground")
  ) {
    return null;
  }

  const path = name.replaceAll("_", "/");
  const parts = path === "index" ? ["index"] : path.split("/");
  const filename = parts.pop() || "index";
  const dir = [outputRoot, ...parts].join("/");
  const output = `${dir ? `${dir}/` : ""}${filename}.md`;

  return { key, path, output };
}

async function fetchMd(baseUrl: string, path: string): Promise<string | null> {
  const url = new URL(`/${path}.md`, baseUrl).toString();
  const res = await fetch(url);
  if (res.ok) {
    const text = await res.text();
    if (text.trim()) return text;
  }
  return null;
}

async function fetchHtml(
  baseUrl: string,
  path: string,
): Promise<string | null> {
  const url = new URL(`/${path}`, baseUrl).toString();
  const res = await fetch(url);
  if (!res.ok) return null;
  const html = await res.text();
  const md = htmlToMarkdown(html);
  return md.trim() ? md : null;
}

function stripScriptsStyles(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

function extractMain(html: string): string {
  const mainMatch = html.match(
    /<div[^>]*class="[^"]*vp-doc[^"]*"[^>]*>[\s\S]*?<\/div>/i,
  );
  if (mainMatch) return mainMatch[0];
  const main = html.match(/<main[^>]*>[\s\S]*?<\/main>/i);
  if (main) return main[0];
  const body = html.match(/<body[^>]*>[\s\S]*?<\/body>/i);
  return body ? body[0] : html;
}

function htmlToMarkdown(rawHtml: string): string {
  let html = stripScriptsStyles(rawHtml);
  html = extractMain(html);

  // Remove nav/footer/aside headers.
  html = html.replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove copy/back links like ← → Back.
  html = html.replace(/<a[^>]*>(?:←|→|Back)<\/a>/gi, "");

  // Block-level replacements.
  html = html.replace(
    /<h1[^>]*>([\s\S]*?)<\/h1>/gi,
    (_, t) => `# ${cleanupText(t)}\n\n`,
  );
  html = html.replace(
    /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
    (_, t) => `## ${cleanupText(t)}\n\n`,
  );
  html = html.replace(
    /<h3[^>]*>([\s\S]*?)<\/h3>/gi,
    (_, t) => `### ${cleanupText(t)}\n\n`,
  );
  html = html.replace(
    /<h4[^>]*>([\s\S]*?)<\/h4>/gi,
    (_, t) => `#### ${cleanupText(t)}\n\n`,
  );

  html = html.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, t) => `\`\`\`\n${decodeHtml(t.trim())}\n\`\`\`\n\n`,
  );
  html = html.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_, t) => `\`${cleanupInline(decodeHtml(t))}\``,
  );

  html = html.replace(
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
    (_, t) => `${cleanupText(t)}\n\n`,
  );
  html = html.replace(/<br\s*\/?>/gi, "\n");

  html = html.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_, t) => `- ${cleanupText(t)}\n`,
  );
  html = html.replace(/<\/ul>/gi, "\n");

  html = html.replace(
    /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `[${cleanupInline(text)}](${href})`,
  );

  // Remove any other tags.
  html = html.replace(/<\/?(div|span|section|article)[^>]*>/gi, "");
  html = html.replace(/<[^>]+>/g, "");

  // Collapse whitespace.
  return html
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupText(t: string): string {
  return decodeHtml(t.replace(/\s+/g, " ").trim());
}

function cleanupInline(t: string): string {
  return decodeHtml(t.replace(/\s+/g, " ").trim());
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

async function ensureDir(path: string) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (!dir) return;
  await mkdir(dir, { recursive: true });
}

async function writeFile(path: string, content: string) {
  await ensureDir(path);
  await Bun.write(path, content.endsWith("\n") ? content : `${content}\n`);
}

async function pullDocs(options: Options) {
  const hashmap = (await fetchJson(
    new URL(HASHMAP_PATH, options.baseUrl).toString(),
  )) as Record<string, string>;
  const pages: Page[] = [];
  for (const key of Object.keys(hashmap)) {
    const page = keyToPage(key, options.output);
    if (page) pages.push(page);
  }
  console.log(`Discovered ${pages.length} pages.`);

  let active = 0;
  let idx = 0;
  let ok = 0;
  let skipped = 0;
  const results: Promise<void>[] = [];

  async function worker(page: Page) {
    try {
      const md =
        (await fetchMd(options.baseUrl, page.path)) ??
        (await fetchHtml(options.baseUrl, page.path));
      if (!md) {
        skipped++;
        console.log(`[skip] ${page.path}`);
        return;
      }
      await writeFile(page.output, md);
      ok++;
      console.log(`[ok] ${page.output}`);
    } catch (err) {
      skipped++;
      console.log(`[err] ${page.path}: ${(err as Error).message}`);
    }
  }

  function next(): void {
    if (idx >= pages.length) return;
    const page = pages[idx++];
    active++;
    const p = worker(page).finally(() => {
      active--;
      next();
    });
    results.push(p);
    if (active < options.workers && idx < pages.length) next();
  }

  for (let i = 0; i < options.workers && i < pages.length; i++) next();
  await Promise.all(results);
  console.log(`Done. ok=${ok} skipped=${skipped}`);
}

pullDocs(opts).catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * Fetch Privy documentation markdown files using Bun/TypeScript.
 *
 * Strategy:
 * - Read sitemap.xml at https://docs.privy.io/sitemap.xml to discover pages.
 * - For each page, fetch the corresponding `.md` (eg: /path.md).
 * - Write to a local output folder (default: privy/), preserving structure.
 *
 * Usage:
 *   bun run scripts/pull_privy_docs.ts [--base-url https://docs.privy.io] [--output privy] [--workers 16]
 */

import { mkdir } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://docs.privy.io";
const SITEMAP_PATH = "/sitemap.xml";
const DEFAULT_OUTPUT = "privy";
const DEFAULT_WORKERS = 16;

type Options = {
  baseUrl: string;
  output: string;
  workers: number;
};

type Page = {
  url: string; // full page URL without .md
  path: string; // relative path without leading slash
  output: string; // local file path
};

const args = Bun.argv.slice(2);

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const opts: Options = {
  baseUrl: getArg("--base-url", DEFAULT_BASE_URL),
  output: getArg("--output", DEFAULT_OUTPUT),
  workers: Number(getArg("--workers", String(DEFAULT_WORKERS))),
};

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const regex = /<loc>(.*?)<\/loc>/g;
  let match: RegExpExecArray | null;
  match = regex.exec(xml);
  while (match !== null) {
    locs.push(match[1].trim());
    match = regex.exec(xml);
  }
  return locs;
}

function urlToPage(
  url: string,
  baseUrl: string,
  outputRoot: string,
): Page | null {
  if (!url.startsWith(baseUrl)) return null;
  const rel = url.slice(baseUrl.length).replace(/^\/+/, ""); // drop leading slash(es)
  if (!rel) return null;
  const path = rel.replace(/\/+$/, ""); // trim trailing slash
  const parts = path.split("/");
  const filename = parts.pop() || "index";
  const dir = [outputRoot, ...parts].join("/");
  const output = `${dir ? `${dir}/` : ""}${filename}.md`;
  return { url, path, output };
}

async function ensureDir(path: string) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (!dir) return;
  await mkdir(dir, { recursive: true });
}

async function writeFile(path: string, content: string) {
  await ensureDir(path);
  await Bun.write(path, content.endsWith("\\n") ? content : `${content}\\n`);
}

async function pullDocs(options: Options) {
  const sitemapUrl = new URL(SITEMAP_PATH, options.baseUrl).toString();
  const xml = await fetchText(sitemapUrl);
  const locs = extractLocs(xml);
  const pages: Page[] = [];
  for (const loc of locs) {
    const page = urlToPage(loc, options.baseUrl, options.output);
    if (page) pages.push(page);
  }
  console.log(`Discovered ${pages.length} pages from sitemap.`);

  let active = 0;
  let idx = 0;
  let ok = 0;
  let skipped = 0;
  const results: Promise<void>[] = [];

  async function worker(page: Page) {
    const mdUrl = `${page.url}.md`;
    try {
      const content = await fetchText(mdUrl);
      await writeFile(page.output, content);
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

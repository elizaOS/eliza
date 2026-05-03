#!/usr/bin/env node
/**
 * Build-time pre-render of the landing route.
 *
 * Runs after `vite build` (client) + `vite build --ssr src/entry-server.tsx`.
 * Imports the SSR bundle's `render(url)` and splices the resulting HTML into
 * `dist/index.html`'s `<div id="root">...</div>`. The client bundle's `main.tsx`
 * detects the children at boot and calls `hydrateRoot` instead of `createRoot`.
 *
 * On failure we leave the original empty-shell `dist/index.html` in place so
 * the SPA still ships; pre-rendering is a perf optimization, not a build
 * gate.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, "..");
const DIST_DIR = resolve(FRONTEND_DIR, "dist");
const SSR_DIR = resolve(FRONTEND_DIR, "dist-ssr");
const INDEX_HTML = resolve(DIST_DIR, "index.html");
const SSR_ENTRY = resolve(SSR_DIR, "entry-server.js");

/** Routes to pre-render. Each entry: [URL path, output filename relative to dist]. */
const ROUTES = [["/", "index.html"]];

const ROOT_OPEN_RE = /<div id="root">/;
const ROOT_CLOSE_TAG = "</div>";

/**
 * Replace the (empty) `<div id="root"></div>` with `<div id="root">{html}</div>`.
 * The Vite client build always emits an empty root div, so a regex anchored on
 * the open tag is sufficient.
 */
function injectRoot(template, rendered, url) {
  const openMatch = template.match(ROOT_OPEN_RE);
  if (!openMatch || openMatch.index === undefined) {
    throw new Error('[prerender] Could not find <div id="root"> in dist/index.html');
  }
  const closeStart = template.indexOf(ROOT_CLOSE_TAG, openMatch.index + openMatch[0].length);
  if (closeStart === -1) {
    throw new Error("[prerender] Could not find </div> closing the root div");
  }
  const normalizedUrl = url.replace(/\/$/, "") || "/";
  const markedOpenTag = `<div id="root" data-prerender-path="${normalizedUrl}">`;
  return template.slice(0, openMatch.index) + markedOpenTag + rendered + template.slice(closeStart);
}

/**
 * Serialize the helmet head into HTML-injectable strings. `react-helmet-async`
 * exposes each tag group as an object with a `.toString()` method that returns
 * the rendered HTML.
 */
function injectHelmet(template, helmet) {
  if (!helmet) return template;
  // Append helmet-managed meta after the existing <head> contents. The static
  // index.html already has a hand-curated set of OG / SEO tags; helmet's
  // additions (e.g. JSON-LD from `app/page.tsx`) are duplicates of those plus
  // page-specific extras. Letting both ship is fine; search engines and
  // social-media crawlers de-dupe by name/property.
  const headClose = template.indexOf("</head>");
  if (headClose === -1) return template;
  const helmetHtml = [
    helmet.title?.toString() ?? "",
    helmet.meta?.toString() ?? "",
    helmet.link?.toString() ?? "",
    helmet.script?.toString() ?? "",
  ]
    .filter(Boolean)
    .join("\n    ");
  if (!helmetHtml) return template;
  return `${template.slice(0, headClose)}    ${helmetHtml}\n  ${template.slice(headClose)}`;
}

async function main() {
  let render;
  try {
    const mod = await import(pathToFileURL(SSR_ENTRY).href);
    render = mod.render;
    if (typeof render !== "function") {
      throw new Error(`SSR entry did not export a 'render' function (got ${typeof render})`);
    }
  } catch (err) {
    console.error("[prerender] Failed to load SSR bundle:", err);
    console.error("[prerender] Skipping prerender; shipping empty-shell index.html.");
    process.exitCode = 0;
    return;
  }

  const template = await readFile(INDEX_HTML, "utf8");

  let succeeded = 0;
  for (const [url, filename] of ROUTES) {
    try {
      const result = render(url);
      const rendered = result?.html ?? "";
      if (!rendered) {
        console.warn(`[prerender] ${url} -> empty HTML, skipping`);
        continue;
      }
      let output = injectRoot(template, rendered, url);
      output = injectHelmet(output, result?.helmet);
      const outPath = resolve(DIST_DIR, filename);
      await writeFile(outPath, output, "utf8");
      const sizeKb = (Buffer.byteLength(output, "utf8") / 1024).toFixed(1);
      console.log(`[prerender] ${url} -> ${filename} (${sizeKb} KB)`);
      succeeded += 1;
    } catch (err) {
      console.error(`[prerender] ${url} failed:`, err);
    }
  }

  // Clean up the SSR bundle; it's only needed for the prerender step and
  // would otherwise get uploaded to Pages as dead weight.
  await rm(SSR_DIR, { recursive: true, force: true }).catch(() => {});

  if (succeeded === 0) {
    console.warn("[prerender] No routes were pre-rendered.");
  }
}

await main();

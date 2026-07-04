/**
 * Bundle a shell fixture with esbuild and wrap it in a static HTML page for the
 * `__e2e__` runners to load over `file://` in headless Chromium. One esbuild
 * config (browser IIFE, tsx/ts loaders, NODE_ENV=production), one HTML skeleton
 * with the knobs the runners actually vary — Tailwind source (CDN vs a compiled
 * theme vs none), the `process` shim, `<html>` class, extra head markup, body
 * background — and an optional real-`@elizaos/ui` Tailwind v4 theme compile.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "@tailwindcss/postcss";
import { build, type Plugin } from "esbuild";
import postcss, { type AcceptedPlugin } from "postcss";

export interface BundleFixtureOptions {
  /** Absolute path to the fixture entry (`.tsx`). */
  entry: string;
  /** esbuild resolve/load plugins (the shared stubs, plus any per-runner ones). */
  plugins?: Plugin[];
  /** Extra `define` entries merged over the default `process.env.NODE_ENV`. */
  define?: Record<string, string>;
}

/** esbuild-bundle a fixture to a browser IIFE and return the JS text. */
export async function bundleFixture({
  entry,
  plugins = [],
  define,
}: BundleFixtureOptions): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"', ...define },
    plugins,
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}

export interface FixtureHtmlOptions {
  /** Bundled fixture JS (from `bundleFixture`). */
  js: string;
  /** `<title>` text. */
  title: string;
  /**
   * Tailwind source: the CDN script (fast, approximate), a compiled theme CSS
   * string (exact shipped brand — see `compileTailwindTheme`), or none.
   */
  tailwind?: "cdn" | "none" | { css: string };
  /** Inject the browser `process` shim before the bundle runs. */
  processShim?: boolean;
  /** `class` on `<html>` (e.g. `"dark"` to activate the dark-glass theme). */
  htmlClass?: string;
  /** Extra markup appended to `<head>` (e.g. a pre-boot observer `<script>`). */
  headHtml?: string;
  /** `background` applied to `html,body` (e.g. `"#16121c"`). */
  background?: string;
}

const PROCESS_SHIM = `<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>`;

/** Wrap bundled fixture JS in the shared static HTML skeleton. */
export function buildFixtureHtml({
  js,
  title,
  tailwind: tw = "cdn",
  processShim = false,
  htmlClass = "",
  headHtml = "",
  background,
}: FixtureHtmlOptions): string {
  const cls = htmlClass ? ` class="${htmlClass}"` : "";
  const tailwindTag =
    tw === "cdn"
      ? `<script src="https://cdn.tailwindcss.com"></script>`
      : tw === "none"
        ? ""
        : `<style>${tw.css}</style>`;
  const shim = processShim ? PROCESS_SHIM : "";
  const bg = background ? `;background:${background}` : "";
  return `<!doctype html><html${cls}><head><meta charset="utf-8"><title>${title}</title>
${tailwindTag}${shim}
<style>html,body{margin:0;height:100%${bg}}</style>
${headHtml}
</head><body><div id="root"></div><script>${js}</script></body></html>`;
}

export interface WriteFixturePageOptions
  extends BundleFixtureOptions,
    Omit<FixtureHtmlOptions, "js"> {
  /** Directory the HTML file is written into (also the artifact output dir). */
  outDir: string;
  /** File name for the written HTML (e.g. `"chat-sheet.html"`). */
  htmlName: string;
}

/** Bundle a fixture, wrap it, write the HTML, and return its `file://` URL. */
export async function writeFixturePage(
  options: WriteFixturePageOptions,
): Promise<string> {
  const { entry, plugins, define, outDir, htmlName, ...htmlOptions } = options;
  const js = await bundleFixture({ entry, plugins, define });
  const html = buildFixtureHtml({ ...htmlOptions, js });
  const htmlPath = join(outDir, htmlName);
  await writeFile(htmlPath, html);
  return `file://${htmlPath}`;
}

export interface CompileTailwindThemeOptions {
  /** `packages/ui` root (the dir holding `src/styles/`). */
  uiRoot: string;
  /** Directories esbuild `@source`-scans for utility classes to emit. */
  sources: string[];
}

/**
 * Compile the real `@elizaos/ui` Tailwind v4 theme (base + theme + tailwind-theme)
 * scoped to the given source dirs, so a fixture's pixels carry the shipped brand
 * (dark glass + orange accent) instead of a CDN-Tailwind approximation.
 */
export async function compileTailwindTheme({
  uiRoot,
  sources,
}: CompileTailwindThemeOptions): Promise<string> {
  const stylesDir = join(uiRoot, "src/styles");
  const toUrl = (p: string) => p.replace(/\\/g, "/");
  const sourceImports = sources
    .map((source) => `@source "${toUrl(source)}";`)
    .join("\n");
  const input = `@import "tailwindcss" source(none);
@import "${toUrl(join(stylesDir, "base.css"))}";
@import "${toUrl(join(stylesDir, "theme.css"))}";
@import "${toUrl(join(stylesDir, "tailwind-theme.css"))}";
${sourceImports}
`;
  // Tailwind's PluginCreator return type recursively expands against PostCSS's
  // AcceptedPlugin union under tsgo; runtime receives the real PostCSS plugin.
  const tailwindPlugin = tailwind() as unknown as AcceptedPlugin;
  const result = await postcss([tailwindPlugin]).process(input, {
    from: toUrl(join(stylesDir, "styles.css")),
  });
  return result.css;
}

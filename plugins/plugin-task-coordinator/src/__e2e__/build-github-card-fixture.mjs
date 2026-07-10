/**
 * Build step for the GitHub connection card screenshot harness (#15796).
 * Bundles github-card-fixture.tsx with esbuild (stubbing `@elizaos/ui` with
 * brand-faithful primitives whose classes are copied from packages/ui
 * button.tsx) and writes the self-contained HTML page the playwright runner
 * loads. Split from run-github-card-shot.mjs because esbuild resolves from
 * bun's isolated store (run this under bun) while playwright's launcher needs
 * node on Windows.
 *
 * Run: bun run plugins/plugin-task-coordinator/src/__e2e__/build-github-card-fixture.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "github-card-shots");
await mkdir(outDir, { recursive: true });

// Stub `@elizaos/ui` (a virtual module, nothing written to src): the card only
// uses Button, SettingsControls.Input, client.fetch, and openExternalUrl. The
// Button/Input classes mirror packages/ui/src/components/ui/button.tsx so the
// pixels match the shipped kit (accent-orange resting → darker-orange hover).
const uiStub = {
  name: "elizaos-ui-stub",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/ui$/ }, () => ({
      path: "elizaos-ui-stub",
      namespace: "ui-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "ui-stub" }, () => ({
      loader: "tsx",
      resolveDir: here,
      contents: `
import * as React from "react";
const VARIANTS = {
  default: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-bg-accent text-txt hover:bg-surface",
};
export function Button({ children, unstyled, variant = "default", size, className = "", ...rest }) {
  const base = unstyled
    ? className
    : "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-colors h-9 px-3 py-1.5 cursor-pointer " +
      (VARIANTS[variant] ?? VARIANTS.default) + " " + className;
  return <button type="button" className={base} {...rest}>{children}</button>;
}
export const SettingsControls = {
  Input: ({ variant, className = "", ...rest }) => (
    <input className={"h-8 rounded-sm border border-border bg-bg px-2 text-xs text-txt placeholder:text-muted " + className} {...rest} />
  ),
};
export const client = { fetch: (path, init) => window.__ghFetch(path, init) };
export function openExternalUrl(url) { window.__openedExternal = url; }
`,
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "github-card-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [uiStub],
  write: false,
});
const js = result.outputFiles[0].text;

// Brand palette (dark theme) wired so Tailwind opacity modifiers resolve
// against real values. Mirrors run-dashboard-shot.mjs.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>github connection card</title>
<script>
window.tailwind = window.tailwind || {};
window.tailwind.config = {
  theme: { extend: { colors: {
    bg: "#07090e", "bg-accent": "#10131b", "bg-hover": "#1a1e28",
    surface: "#161a23", card: "#0c0f16",
    txt: "#f4f5f7", "txt-strong": "#ffffff",
    muted: "#9aa0ad", "muted-strong": "#c3c8d2", border: "#272b36",
    accent: "#ff5800", "accent-hover": "#e04d00", "accent-fg": "#ffffff",
    "accent-subtle": "rgba(255,88,0,0.14)",
    ok: "#4ade80", warn: "#ff8a3d", danger: "#f87171",
  } } },
};
</script>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#07090e}
/* Brand palette injected explicitly so it survives whichever Tailwind the CDN
   serves (v4 ignores the JS color config). Source order wins. */
.text-txt{color:#f4f5f7}.text-muted{color:#9aa0ad}
.text-accent{color:#ff5800}.text-amber-500{color:#f59e0b}
.text-rose-500{color:#f43f5e}.text-emerald-500{color:#10b981}
.bg-bg{background-color:#07090e}.bg-card{background-color:#0c0f16}
.bg-bg-accent{background-color:#10131b}.bg-bg-accent\\/40{background-color:rgba(16,19,27,.4)}
.bg-surface{background-color:#161a23}
.bg-accent{background-color:#ff5800}.hover\\:bg-accent-hover:hover{background-color:#e04d00}
.text-accent-fg{color:#ffffff}
.bg-emerald-500{background-color:#10b981}.bg-muted\\/40{background-color:rgba(154,160,173,.4)}
.bg-rose-500\\/10{background-color:rgba(244,63,94,.1)}
.border-border{border-color:#272b36}.border-rose-500\\/40{border-color:rgba(244,63,94,.4)}
</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "github-card.html");
await writeFile(htmlPath, html);

console.log(`Fixture page → ${htmlPath}`);

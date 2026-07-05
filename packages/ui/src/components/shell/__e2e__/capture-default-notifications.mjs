/**
 * Screenshot the integrated notification center rendering the default
 * (onboarding) notification set, desktop + mobile. No app server: bundles the
 * fixture with esbuild (core/node builtins stubbed dead-in-browser) and shoots
 * it in headless chromium. Evidence for #13537.
 *
 * Run: bun packages/ui/src/components/shell/__e2e__/capture-default-notifications.mjs
 */
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-notifications");
await mkdir(outDir, { recursive: true });

const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            DEFAULT_NOTIFICATION_CATEGORY: "general",
            DEFAULT_NOTIFICATION_PRIORITY: "normal",
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "notifications-center-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`bundled (${js.length} bytes)`);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>notifications e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16;color:#f4f4f5;font-family:ui-sans-serif,system-ui}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "notifications.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const browser = await chromium.launch();
let failures = 0;
for (const [name, width, height] of [
  ["desktop", 1280, 900],
  ["mobile", 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(1200);
  const cards = await page.locator("text=Take the tour").count();
  console.log(`${name}: "Take the tour" visible = ${cards >= 1}`);
  if (cards < 1) failures += 1;
  if (errors.length) {
    console.log(`${name} page errors:`, errors);
    failures += 1;
  }
  await page.screenshot({
    path: join(outDir, `notifications-${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}.png`);
  await page.close();
}
await browser.close();
console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

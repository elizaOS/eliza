// Screenshot-evidence runner for L1 launcher content policy.
// Bundles l1-policy-fixture.tsx (real Launcher + real curateLauncherPages)
// and captures BEFORE (old dev default: developer views on), AFTER (new
// default: off), and toggled-on states in headless Chromium.
import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKTREE =
  "/Users/shawwalters/eliza-workspace/eliza/eliza/.claude/worktrees/ui-interaction-epic";
// Run this script with bun from packages/ui so these resolve.
const { build } = await import("esbuild");
const { chromium } = await import("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(
  WORKTREE,
  ".github/issue-evidence/ui-interaction-epic/l1-launcher",
);
await mkdir(outDir, { recursive: true });

// Real view-kind semantics inline (mirrors @elizaos/core/types/view-kind.ts,
// which is unit-tested there) — the generic no-op stub would break the policy
// under test by making isViewVisible() always true.
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
        function resolveViewKind(decl) {
          if (decl && decl.viewKind) return decl.viewKind;
          if (decl && decl.developerOnly) return "developer";
          return "release";
        }
        function isViewVisible(decl, enabled) {
          const kind = resolveViewKind(decl);
          if (kind === "system" || kind === "release") return true;
          if (kind === "developer") return enabled.developer;
          if (kind === "preview") return enabled.preview;
          return false;
        }
        module.exports = new Proxy(
          {
            isViewVisible,
            resolveViewKind,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
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
const aliasUi = {
  name: "alias-ui",
  setup(b) {
    b.onResolve({ filter: /^@ui\// }, (args) => ({
      path: join(WORKTREE, "packages/ui/src", args.path.slice(4)),
      namespace: "file",
      pluginData: args.pluginData,
      // Let esbuild finish resolving extensions itself.
      external: false,
    }));
  },
};
// esbuild alias option is simpler:
const result = await build({
  entryPoints: [join(here, "l1-policy-fixture.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  absWorkingDir: WORKTREE,
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@ui": join(WORKTREE, "packages/ui/src") },
  nodePaths: [
    join(WORKTREE, "packages/ui/node_modules"),
    join(WORKTREE, "node_modules"),
  ],
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`fixture bundled (${js.length} bytes)`);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>l1 policy</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16;color:#f4f4f5}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script type="module">${js}</script></body></html>`;
const htmlPath = join(here, "l1-policy.html");
await writeFile(htmlPath, html);

const browser = await chromium.launch();
const errors = [];
let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK " : "FAIL"} ${msg}`);
  if (!cond) failures += 1;
}

async function capture(mode, outName, expectPages, alsoPage2Name) {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 900 },
  });
  page.on("pageerror", (e) => errors.push(`${mode}: ${e}`));
  await page.goto(`file://${htmlPath}?mode=${mode}`);
  await page.waitForSelector('[data-testid="launcher"]');
  await page.waitForTimeout(500);
  const pages = await page.evaluate(() => window.__policyPages);
  assert(
    pages.length === expectPages,
    `${mode}: curation produced ${pages.length} page(s), expected ${expectPages} — ${JSON.stringify(pages.map((p) => p.length))}`,
  );
  if (mode !== "before") {
    assert(
      !pages.flat().includes("logs") === (mode === "after"),
      `${mode}: logs tile ${mode === "after" ? "absent" : "present"} as expected`,
    );
  }
  assert(
    !pages.flat().includes("rolodex"),
    `${mode}: dead rolodex tile is collapsed onto relationships`,
  );
  await page.screenshot({
    path: join(outDir, outName),
    animations: "disabled",
  });
  console.log(`  saved ${outName}`);
  if (alsoPage2Name) {
    // Navigate to the Developer page via the Page 2 dot and capture it.
    await page.getByRole("button", { name: "Page 2" }).click();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: join(outDir, alsoPage2Name),
      animations: "disabled",
    });
    console.log(`  saved ${alsoPage2Name}`);
  }
  await page.close();
}

await capture(
  "before",
  "launcher-dev-default-BEFORE.png",
  2,
  "launcher-dev-default-BEFORE-devpage.png",
);
await capture("after", "launcher-dev-default-AFTER.png", 1);
await capture(
  "toggled-on",
  "launcher-dev-toggle-on-AFTER.png",
  2,
  "launcher-dev-toggle-on-AFTER-devpage.png",
);

assert(errors.length === 0, `no page errors (${errors.length})`);
for (const e of errors) console.error(`  ${e}`);
await browser.close();
process.exit(failures > 0 ? 1 : 0);

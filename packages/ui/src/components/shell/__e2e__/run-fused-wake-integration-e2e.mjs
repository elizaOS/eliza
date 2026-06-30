/**
 * FULL-CHAIN integration e2e for #10351 on a real desktop.
 *
 * Runs the REAL desktop producer (`FusedWakeManager`, electrobun main module:
 * real `libwakeword` + `DesktopMicSource` fed the real "hey eliza" clip + the
 * real `OpenWakeWordDetector`) in this Bun process, bridges its
 * `sendToWebview('voice:fusedWake', …)` into a headless-Chromium page running the
 * REAL renderer transport (`registerDesktopFusedWake`) + the REAL shell
 * (`useWakeController`/`useWakeListenWindow`/HomePill/ChatSurface), and asserts
 * the bottom bar activates + a converse capture starts.
 *
 * The ONLY mocked element is the electrobun IPC pipe (a `window` RPC shim) — not
 * the producer, not the consumer. So this exercises the entire
 * producer→transport→renderer→bar chain end to end with the real native model.
 *
 * Run: bun run --cwd packages/ui test:fused-wake-integration-e2e
 * Needs the prebuilt libwakeword + the 3 hey-eliza GGUFs staged (see
 * wake-word-real-fire.real.test.ts); skips (exit 0, ::notice::) when absent.
 */

import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../..");
const repoRoot = resolve(uiRoot, "../..");
const stylesDir = join(uiRoot, "src/styles");
const toUrl = (p) => p.replace(/\\/g, "/");

// Resolve the `@elizaos/plugin-local-inference/voice-wake` subpath to the in-tree
// barrel so we can import the REAL FusedWakeManager in this worktree (its
// node_modules symlinks the package to a checkout without the new export).
plugin({
  name: "voice-wake-subpath-alias",
  setup(b) {
    b.onResolve(
      { filter: /^@elizaos\/plugin-local-inference\/voice-wake$/ },
      () => ({
        path: join(
          repoRoot,
          "plugins/plugin-local-inference/src/voice-wake.ts",
        ),
      }),
    );
  },
});

const CLIP = join(
  repoRoot,
  "plugins/plugin-local-inference/src/services/voice/__fixtures__/hey-eliza-16k.f32",
);
const LIB_CANDIDATES = [
  process.env.ELIZA_WAKEWORD_LIB,
  join(
    repoRoot,
    "packages/native/plugins/wakeword-cpp/build/libwakeword.dylib",
  ),
  join(repoRoot, "packages/native/plugins/wakeword-cpp/build/libwakeword.so"),
].filter(Boolean);
const LIB = LIB_CANDIDATES.find((p) => existsSync(p));

if (!existsSync(CLIP) || !LIB) {
  console.log(
    `::notice::fused-wake integration e2e skipped — ${!LIB ? "libwakeword not built" : "clip fixture missing"}`,
  );
  process.exit(0);
}

// Feed the real clip into the real DesktopMicSource (deterministic capture) and
// point the standalone resolver at the built lib.
process.env.ELIZA_WAKEWORD_LIB = LIB;
process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM = "ffmpeg";
process.env.ELIZA_FUSED_WAKE_MIC_ARGV = [
  "-hide_banner", "-loglevel", "error",
  // `-re` streams the clip at real time (≈4.3 s) like a live mic, so the head
  // fires ~2–4 s in — after the resting-state baseline is captured.
  "-re",
  "-f", "f32le", "-ar", "16000", "-ac", "1", "-i", CLIP,
  "-ar", "16000", "-ac", "1", "-f", "s16le", "-",
].join("|");

// Import the REAL desktop producer (resolves through the alias above).
const { FusedWakeManager } = await import(
  join(
    repoRoot,
    "packages/app-core/platforms/electrobun/src/native/fused-wake.ts",
  )
);

const outDir = join(here, "output-fused-wake-integration");
await mkdir(outDir, { recursive: true });

async function compileTheme() {
  const input = `@import "tailwindcss" source(none);
@import "${toUrl(join(stylesDir, "base.css"))}";
@import "${toUrl(join(stylesDir, "theme.css"))}";
@import "${toUrl(join(stylesDir, "tailwind-theme.css"))}";
@source "${toUrl(join(uiRoot, "src/components/shell"))}";
@source "${toUrl(here)}";
`;
  const res = await postcss([tailwind()]).process(input, {
    from: toUrl(join(stylesDir, "styles.css")),
  });
  return res.css;
}

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
          { isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [] },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );`,
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
      )
        return { path: args.path, namespace: "node-stub" };
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
  entryPoints: [join(here, "fused-wake-integration-fixture.tsx")],
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
const themeCss = await compileTheme();
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>fused wake integration e2e</title>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>${themeCss}</style><style>html,body{margin:0;height:100%;background:#08080d}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "fused-wake-integration.html");
await writeFile(htmlPath, html);

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}
let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const manager = new FusedWakeManager();
const browser = await chromium.launch({
  timeout: Number(process.env.PW_LAUNCH_TIMEOUT_MS || 300000),
});
const sink = { logs: [], errors: [] };
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
  });
  const p = await ctx.newPage();
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));

  // Producer → renderer: every FusedWakeManager sendToWebview is delivered into
  // the page's mock electrobun RPC (the only mocked hop).
  manager.setSendToWebview((message, payload) => {
    void p.evaluate(
      ({ message, payload }) =>
        window.__deliverElectrobunMessage?.(message, payload),
      { message, payload },
    );
  });

  // Page → host: the renderer's registerDesktopFusedWake invokes
  // `fusedWake:start`; that starts the REAL native detector here.
  await p.exposeFunction("__hostFusedWakeStart", async (params) => {
    const r = await manager.start(params ?? {});
    console.log(`[host] FusedWakeManager.start → ${JSON.stringify(r)}`);
    return r;
  });
  await p.exposeFunction("__hostFusedWakeStop", async () => {
    await manager.stop();
    return undefined;
  });

  await p.goto(`file://${htmlPath}`);
  await p.waitForSelector('[data-testid="shell-home-pill"]', { timeout: 20000 });
  await p.waitForTimeout(600);

  assert(
    (await p.getByTestId("shell-home-pill").count()) === 1,
    "RESTING: chromeless HomePill bar before wake",
  );
  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 0,
    "RESTING: no composer before wake",
  );
  assert(
    await p.evaluate(() => window.__ELIZA_FUSED_WAKE__ === true),
    "registerDesktopFusedWake set the capability flag",
  );
  await snap(p, "resting-homepill");

  // The real native detector is now streaming the real clip; wait for the head
  // to fire → voice:fusedWake → bar activation (the bar surfaces ChatSurface).
  await p.waitForSelector('[data-testid="shell-chat-surface"]', {
    timeout: 20000,
  });
  await p.waitForTimeout(700);

  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 1,
    "WAKE: real libwakeword fire → voice:fusedWake → bar activates (ChatSurface)",
  );
  assert(
    sink.logs.some((l) =>
      l.includes("wake -> onOpen: startCapture('converse')"),
    ),
    "WAKE: the real wake opened the listening window + started a converse capture",
  );
  await snap(p, "wake-bar-active");

  assert(
    sink.errors.length === 0,
    `NO PAGE ERRORS (${JSON.stringify(sink.errors.slice(0, 4))})`,
  );

  const videoObj = p.video();
  await manager.stop();
  await p.close();
  if (videoObj) {
    const vp = await videoObj.path().catch(() => null);
    if (vp) console.log(`  🎥 video: ${vp}`);
  }
  await ctx.close();
} finally {
  await browser.close();
  await manager.stop().catch(() => {});
}

console.log(
  `\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — artifacts in ${outDir}`,
);
process.exit(failures === 0 ? 0 : 1);

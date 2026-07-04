/**
 * FULL-CHAIN integration e2e for #10351 on a real desktop. Runs the REAL desktop
 * producer (FusedWakeManager: real libwakeword + DesktopMicSource fed the real
 * "hey eliza" clip + the real OpenWakeWordDetector) in this Bun process, bridges
 * its sendToWebview into a headless-Chromium page running the REAL renderer
 * transport + shell, and asserts the bottom bar activates + a converse capture
 * starts. The only mocked element is the electrobun IPC pipe (a window RPC shim).
 * Fixture bundling + theme compile + assert/snap come from the shared e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:fused-wake-integration-e2e
 * Needs the prebuilt libwakeword + the 3 hey-eliza GGUFs staged (see
 * wake-word-real-fire.real.test.ts); skips (exit 0, ::notice::) when absent.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import {
  compileTailwindTheme,
  createAssertGate,
  createSnapper,
  finishRun,
  renameRecordedVideo,
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../..");
const repoRoot = resolve(uiRoot, "../..");

// Resolve the `@elizaos/plugin-local-inference/voice-wake` subpath to the in-tree
// barrel so we can import the REAL FusedWakeManager in this worktree (its
// node_modules symlinks the package to a checkout without the new export).
plugin({
  name: "voice-wake-subpath-alias",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/plugin-local-inference\/voice-wake$/ }, () => ({
      path: join(repoRoot, "plugins/plugin-local-inference/src/voice-wake.ts"),
    }));
  },
});

const CLIP = join(
  repoRoot,
  "plugins/plugin-local-inference/src/services/voice/__fixtures__/hey-eliza-16k.f32",
);
const LIB_CANDIDATES = [
  process.env.ELIZA_WAKEWORD_LIB,
  join(repoRoot, "packages/native/plugins/wakeword-cpp/build/libwakeword.dylib"),
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
  join(repoRoot, "packages/app-core/platforms/electrobun/src/native/fused-wake.ts")
);

const outDir = join(here, "output-fused-wake-integration");
const videoDir = join(outDir, "video");
await mkdir(videoDir, { recursive: true });

const viewport = { width: 1440, height: 900 };
const themeCss = await compileTailwindTheme({
  uiRoot,
  sources: [join(uiRoot, "src/components/shell"), here],
});
const url = await writeFixturePage({
  entry: join(here, "fused-wake-integration-fixture.tsx"),
  outDir,
  htmlName: "fused-wake-integration.html",
  title: "fused wake integration e2e",
  plugins: [stubElizaCore(), stubNodeBuiltins()],
  processShim: true,
  htmlClass: "dark",
  tailwind: { css: themeCss },
  background: "#08080d",
});

const gate = createAssertGate();
const snap = createSnapper({ outDir });
const { assert } = gate;

const manager = new FusedWakeManager();
const browser = await chromium.launch({
  timeout: Number(process.env.PW_LAUNCH_TIMEOUT_MS || 300000),
});
const sink = { logs: [], errors: [] };
try {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: viewport },
  });
  const p = await ctx.newPage();
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));

  // Producer → renderer: every FusedWakeManager sendToWebview is delivered into
  // the page's mock electrobun RPC (the only mocked hop).
  manager.setSendToWebview((message, payload) => {
    void p.evaluate(
      ({ message, payload }) => window.__deliverElectrobunMessage?.(message, payload),
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

  await p.goto(url);
  await p.waitForSelector('[data-testid="shell-home-pill"]', { timeout: 20000 });
  await p.waitForTimeout(600);

  assert(
    (await p.getByTestId("shell-home-pill").count()) === 1,
    "RESTING: chromeless HomePill bar before wake",
  );
  assert((await p.getByTestId("shell-chat-surface").count()) === 0, "RESTING: no composer before wake");
  assert(
    await p.evaluate(() => window.__ELIZA_FUSED_WAKE__ === true),
    "registerDesktopFusedWake set the capability flag",
  );
  await snap(p, "resting-homepill");

  // The real native detector is now streaming the real clip; wait for the head
  // to fire → voice:fusedWake → bar activation (the bar surfaces ChatSurface).
  await p.waitForSelector('[data-testid="shell-chat-surface"]', { timeout: 20000 });
  await p.waitForTimeout(700);

  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 1,
    "WAKE: real libwakeword fire → voice:fusedWake → bar activates (ChatSurface)",
  );
  assert(
    sink.logs.some((l) => l.includes("wake -> onOpen: startCapture('converse')")),
    "WAKE: the real wake opened the listening window + started a converse capture",
  );
  await snap(p, "wake-bar-active");

  assert(sink.errors.length === 0, `NO PAGE ERRORS (${JSON.stringify(sink.errors.slice(0, 4))})`);

  await manager.stop();
  await p.close();
  await ctx.close();
} finally {
  await browser.close();
  await manager.stop().catch(() => {});
}

await renameRecordedVideo({ videoDir, outDir, name: "fused-wake-integration.webm" });

finishRun({
  failures: gate.failures,
  passMessage: `\nPASS — artifacts in ${outDir}`,
  failMessage: `\nFAIL (${gate.failures}) — artifacts in ${outDir}`,
});

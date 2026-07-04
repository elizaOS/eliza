/**
 * Recorded packaged-desktop CHAT walkthrough (#12188 — desktop video lane).
 *
 * Desktop was the only platform with no walkthrough video (web has Playwright
 * `recordVideo`, Android has `adb screenrecord`, iOS has `simctl recordVideo`;
 * the Electrobun packaged harness only had single-PNG bridge screenshots). This
 * spec closes that gap: it boots the REAL packaged Electrobun app, starts the
 * bridge frame-pump recorder (`bridge-frame-recorder.ts`), then drives the real
 * desktop chat surface over the bridge `eval` RPC — summon the assistant from the
 * resting home pill, type into the composer, send messages, watch the agent's
 * streamed reply land, and dismiss — and stitches the captured frames into a
 * real-time MP4.
 *
 * The desktop resting surface is the chromeless bottom bar / home pill
 * (`shell-home-pill`); tapping it flips the shell controller to `summoned`, which
 * reveals `AssistantOverlay` → `ChatSurface` (`shell-chat-surface`) with a
 * controlled `<input>` composer and `<li>` transcript rows. We drive it through
 * real DOM events (a real click on the pill button, a React-controlled value set
 * + `input` event on the composer, the composer's real Enter keybinding) rather
 * than synthetic pointer/keyboard injection — the WKWebView/WebKitGTK webview
 * exposes no CDP. Each step asserts the state transition it triggered, so a green
 * run proves the chat round-trip actually happened, and the MP4 is a
 * human-watchable record of the whole flow.
 *
 * The recorder polls screenshots concurrently with the driving `eval` calls; the
 * bridge shares one webview, so state reads are spaced out (not tight-polled) and
 * `bridgeEval` rides out the transient eval slowness a busy webview shows while
 * it streams a reply or paints the shader background.
 *
 * Requires a prebuilt Electrobun binary (see playwright.electrobun.packaged.config.ts;
 * `ELIZA_TEST_PACKAGED_LAUNCHER_PATH` overrides the resolved launcher) and ffmpeg
 * on PATH for the stitch.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { assertScreenshotNotBlank } from "../ui-smoke/helpers/screenshot-quality";
import {
  type BridgeFrameRecording,
  startBridgeFrameRecording,
} from "./bridge-frame-recorder";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

const FIRST_PROMPT = "What can you help me with today?";
const SECOND_PROMPT = "Give me a two-line summary of my day.";
/** Substring the mock's streamed assistant reply always contains. */
const REPLY_MARKER = "mock reply to";

/** Minimum acceptable recording so a truncated/blank capture fails loudly. */
const MIN_DURATION_SECONDS = 4;
const MIN_FRAME_COUNT = 14;

interface ShellState {
  pillPresent: boolean;
  pillPhase: string | null;
  chatSurfacePresent: boolean;
  composerValue: string | null;
  messageCount: number;
  transcriptText: string;
}

function decodeBridgePng(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a bridge `eval`, retrying only on the transient 5s timeout a busy webview
 * shows while it streams a reply / paints the shader background (a real script
 * error still throws immediately). Not serialized with the recorder's
 * screenshots: a mutex would let a slow eval freeze recording, so they run
 * concurrently and each rides out the other's contention via retries.
 */
async function bridgeEval<T>(
  harness: PackagedDesktopHarness,
  script: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await harness.eval<T>(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out after/.test(message)) throw error;
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForRendererShellReady(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const deadline = Date.now() + (process.env.CI ? 120_000 : 60_000);
  let last: EvalResult<{ ready: boolean; rootLength: number }> | undefined;
  while (Date.now() < deadline) {
    last = await bridgeEval<EvalResult<{ ready: boolean; rootLength: number }>>(
      harness,
      `(() => {
        try {
          const rootHtml = document.getElementById("root")?.innerHTML ?? "";
          const startupShell = document.querySelector('[data-testid="startup-shell-loading"]');
          const firstRunOverlay = document.querySelector('[data-testid="first-run-shell"]');
          return {
            ok: true,
            ready: rootHtml.length > 200 && !startupShell && !firstRunOverlay,
            rootLength: rootHtml.length,
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })()`,
    );
    if (last.ok && last.ready) return;
    await delay(500);
  }
  throw new Error(
    `Expected packaged desktop renderer to finish startup. Last: ${JSON.stringify(last)}`,
  );
}

/** Reads a compact snapshot of the shell + chat surface via the bridge. */
async function readShellState(
  harness: PackagedDesktopHarness,
): Promise<ShellState> {
  const result = await bridgeEval<EvalResult<ShellState>>(
    harness,
    `(() => {
      try {
        const pill = document.querySelector('[data-testid="shell-home-pill"]');
        const surface = document.querySelector('[data-testid="shell-chat-surface"]');
        const input = surface ? surface.querySelector('input') : null;
        const rows = surface ? Array.from(surface.querySelectorAll('li')) : [];
        return {
          ok: true,
          pillPresent: Boolean(pill),
          pillPhase: pill ? pill.getAttribute('data-phase') : null,
          chatSurfacePresent: Boolean(surface),
          composerValue: input instanceof HTMLInputElement ? input.value : null,
          messageCount: rows.length,
          transcriptText: rows
            .map((row) => (row.textContent || "").replace(/\\s+/g, " ").trim())
            .join(" │ ")
            .slice(0, 800),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`readShellState failed: ${result.error}`);
  }
  return result;
}

/**
 * Gentle state poll: reads shell state every ~700ms (not a tight loop) so the
 * concurrent recorder keeps getting frame windows and the webview is not hammered
 * with back-to-back evals. Returns the first state satisfying `predicate`.
 */
async function waitForShellState(
  harness: PackagedDesktopHarness,
  predicate: (state: ShellState) => boolean,
  options: { message: string; timeoutMs?: number; gapMs?: number },
): Promise<ShellState> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const gapMs = options.gapMs ?? 700;
  const deadline = Date.now() + timeoutMs;
  let last: ShellState | null = null;
  while (Date.now() < deadline) {
    last = await readShellState(harness);
    if (predicate(last)) return last;
    await delay(gapMs);
  }
  throw new Error(
    `${options.message}\nLast shell state: ${JSON.stringify(last)}`,
  );
}

/** Clicks the resting home pill — the real "summon assistant" affordance. */
async function clickHomePill(harness: PackagedDesktopHarness): Promise<void> {
  const result = await bridgeEval<EvalResult<Record<string, never>>>(
    harness,
    `(() => {
      try {
        const pill = document.querySelector('[data-testid="shell-home-pill"]');
        if (!(pill instanceof HTMLElement)) {
          return { ok: false, error: "home pill not found" };
        }
        pill.click();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`clickHomePill failed: ${result.error}`);
  }
}

/**
 * Types into the ChatSurface composer. It is a React-controlled `<input>`, so we
 * set the value through the native setter and fire a bubbling `input` event —
 * the only way to update React's tracked value without CDP keyboard injection.
 */
async function typeIntoComposer(
  harness: PackagedDesktopHarness,
  text: string,
): Promise<void> {
  const result = await bridgeEval<EvalResult<{ value: string }>>(
    harness,
    `(() => {
      try {
        const input = document.querySelector('[data-testid="shell-chat-surface"] input');
        if (!(input instanceof HTMLInputElement)) {
          return { ok: false, error: "chat composer input not found" };
        }
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!setter) return { ok: false, error: "no native value setter" };
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, value: input.value };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`typeIntoComposer failed: ${result.error}`);
  }
}

/**
 * Computes the physical-pixel crop rect for the app window inside the full-screen
 * bridge screenshot: window bounds (logical) × devicePixelRatio, clamped to the
 * actual screenshot size. Returns null if it cannot be resolved (fall back to the
 * full frame).
 */
async function computeWindowCropRect(
  harness: PackagedDesktopHarness,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const state = await harness.getState();
  const bounds = state.mainWindow.bounds;
  if (!bounds) return null;
  const dpr = await bridgeEval<number>(
    harness,
    "(() => (typeof window !== 'undefined' && window.devicePixelRatio) || 1)()",
  );
  const frame = await sharp(
    decodeBridgePng(await harness.screenshot()),
  ).metadata();
  if (!frame.width || !frame.height) return null;

  const x = Math.max(0, Math.round(bounds.x * dpr));
  const y = Math.max(0, Math.round(bounds.y * dpr));
  const width = Math.min(frame.width - x, Math.round(bounds.width * dpr));
  const height = Math.min(frame.height - y, Math.round(bounds.height * dpr));
  if (width < 200 || height < 200) return null;
  return { x, y, width, height };
}

/** Presses Enter in the composer — the ChatSurface's real send keybinding. */
async function sendComposer(harness: PackagedDesktopHarness): Promise<void> {
  const result = await bridgeEval<EvalResult<Record<string, never>>>(
    harness,
    `(() => {
      try {
        const input = document.querySelector('[data-testid="shell-chat-surface"] input');
        if (!(input instanceof HTMLInputElement)) {
          return { ok: false, error: "chat composer input not found" };
        }
        input.focus();
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`sendComposer failed: ${result.error}`);
  }
}

test("packaged desktop chat walkthrough records a real-time MP4", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.setTimeout(600_000);

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-desktop-chat-walkthrough-"),
  );
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first, or set ELIZA_TEST_PACKAGED_LAUNCHER_PATH).",
  ).toBeTruthy();

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  let recording: BridgeFrameRecording | null = null;

  try {
    api = await startMockApiServer({ firstRunComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath: launcherPath as string,
      apiBase: api.baseUrl,
    });

    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
    });

    await harness.setMainWindowBounds({ x: 0, y: 0, width: 1240, height: 860 });
    await harness.showMainWindow();
    await harness.focusMainWindow();
    await harness.waitForState(
      (state) =>
        (state.mainWindow.bounds?.width ?? 0) >= 1100 &&
        (state.mainWindow.bounds?.height ?? 0) >= 760 &&
        state.shell.windowVisible,
      "Expected packaged desktop window to report screenshot-sized visible bounds.",
      30_000,
    );
    await waitForRendererShellReady(harness);

    // The agent must be ready (pill leaves the disabled `booting` phase) before
    // the pill will summon.
    const activeHarness = harness;
    await waitForShellState(
      activeHarness,
      (state) => state.pillPresent && state.pillPhase !== "booting",
      {
        message: "Expected the shell to leave the booting phase (agent ready).",
        timeoutMs: 120_000,
      },
    );

    // The macOS bridge screenshot captures the whole display; crop each frame to
    // the app window (bounds × devicePixelRatio) so the clip focuses on the app.
    const cropRect = await computeWindowCropRect(activeHarness);

    const frameDir = testInfo.outputPath("walkthrough-frames");
    const mp4Path = testInfo.outputPath("desktop-chat-walkthrough.mp4");
    const rec = startBridgeFrameRecording({
      captureFrame: async () =>
        decodeBridgePng(await activeHarness.screenshot()),
      frameDir,
      mp4Path,
      fps: 8,
      // No inter-frame gap needed: capture only runs during quiet dwells (the
      // pump is paused through every eval phase), so screenshots never contend.
      minFrameGapMs: 0,
      ...(cropRect ? { cropRect } : {}),
      label: "desktop-chat-walkthrough",
    });
    recording = rec;
    // The bridge is single-threaded, so screenshots and `eval`s cannot run
    // concurrently without starving each other. Capture ONLY during these quiet
    // dwells (no evals in flight); keep the pump paused through every action /
    // assertion phase. The recorder elides the paused gaps so the clip stays a
    // continuous real-time walkthrough of each settled + streaming state.
    rec.pause();
    const capturedDwell = async (ms: number): Promise<void> => {
      rec.resume();
      await delay(ms);
      rec.pause();
    };

    // 1. Resting home — the chromeless bottom bar / home pill.
    await capturedDwell(2_600);

    // 2. Summon the assistant. Retry the click a few times: the first can race
    //    the readiness broadcast.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if ((await readShellState(activeHarness)).chatSurfacePresent) break;
      await clickHomePill(activeHarness);
      await delay(1_000);
    }
    const summoned = await waitForShellState(
      activeHarness,
      (state) => state.chatSurfacePresent,
      {
        message: "Expected clicking the home pill to summon the chat surface.",
      },
    );
    expect(summoned.pillPhase).toBe("summoned");
    await capturedDwell(2_400);

    // 3. Type the first prompt into the composer.
    await typeIntoComposer(activeHarness, FIRST_PROMPT);
    await waitForShellState(
      activeHarness,
      (state) => state.composerValue === FIRST_PROMPT,
      { message: "Expected the composer to hold the typed prompt." },
    );
    await capturedDwell(2_400);

    // 4. Send — the user's message lands, the composer clears, and the mock
    //    streams a real assistant reply back token by token. Capture the
    //    streaming animation during a quiet dwell, THEN assert it landed.
    const beforeSend = await readShellState(activeHarness);
    await sendComposer(activeHarness);
    await capturedDwell(3_600);
    const afterFirstSend = await waitForShellState(
      activeHarness,
      (state) =>
        state.messageCount > beforeSend.messageCount &&
        state.transcriptText.includes(REPLY_MARKER),
      {
        message:
          "Expected the first prompt to add a user row and stream an assistant reply.",
        timeoutMs: 30_000,
      },
    );
    expect(afterFirstSend.composerValue).toBe("");
    expect(afterFirstSend.transcriptText).toContain(FIRST_PROMPT);
    await capturedDwell(2_200);

    // 5. Second turn — type + send again (multi-message conversation on video).
    const beforeSecondSend = await readShellState(activeHarness);
    await typeIntoComposer(activeHarness, SECOND_PROMPT);
    await waitForShellState(
      activeHarness,
      (state) => state.composerValue === SECOND_PROMPT,
      { message: "Expected the composer to hold the second prompt." },
    );
    await capturedDwell(2_000);
    await sendComposer(activeHarness);
    await capturedDwell(3_600);
    const afterSecondSend = await waitForShellState(
      activeHarness,
      (state) =>
        state.messageCount > beforeSecondSend.messageCount &&
        state.transcriptText.includes(SECOND_PROMPT),
      {
        message: "Expected the second prompt to add more message rows.",
        timeoutMs: 30_000,
      },
    );
    expect(afterSecondSend.transcriptText).toContain(SECOND_PROMPT);
    await capturedDwell(2_400);

    // 6. Dismiss the assistant — clicking the pill again returns to the resting
    //    bottom bar (summon -> chat -> dismiss is the real desktop state loop).
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (!(await readShellState(activeHarness)).chatSurfacePresent) break;
      await clickHomePill(activeHarness);
      await delay(1_000);
    }
    await waitForShellState(
      activeHarness,
      (state) => !state.chatSurfacePresent,
      { message: "Expected clicking the pill again to dismiss the chat." },
    );
    await capturedDwell(2_400);

    const result = await rec.stop();
    recording = null;

    // The recording must be a real, non-trivial, non-blank clip.
    await fs.access(result.mp4Path);
    expect(
      result.durationSeconds,
      `walkthrough MP4 was only ${result.durationSeconds.toFixed(2)}s`,
    ).toBeGreaterThan(MIN_DURATION_SECONDS);
    expect(result.frameCount).toBeGreaterThan(MIN_FRAME_COUNT);

    const frameFiles = (await fs.readdir(frameDir))
      .filter((name) => name.endsWith(".png"))
      .sort();
    expect(frameFiles.length).toBe(result.frameCount);
    const sampleIndices = [
      0,
      Math.floor(frameFiles.length / 2),
      frameFiles.length - 1,
    ];
    for (const index of sampleIndices) {
      const frameBuffer = await fs.readFile(
        path.join(frameDir, frameFiles[index]),
      );
      await assertScreenshotNotBlank(
        frameBuffer,
        `walkthrough frame ${frameFiles[index]}`,
      );
    }

    await testInfo.attach("desktop-chat-walkthrough.mp4", {
      path: result.mp4Path,
      contentType: "video/mp4",
    });
    for (const index of sampleIndices) {
      await testInfo.attach(`walkthrough-frame-${frameFiles[index]}`, {
        path: path.join(frameDir, frameFiles[index]),
        contentType: "image/png",
      });
    }

    // Commit-ready evidence copy (opt-in so CI runs never dirty the tree).
    const evidenceDir =
      process.env.ELIZA_DESKTOP_WALKTHROUGH_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.copyFile(
        result.mp4Path,
        path.join(evidenceDir, "desktop-chat-walkthrough.mp4"),
      );
      const labels = ["open", "mid", "end"];
      for (let i = 0; i < sampleIndices.length; i += 1) {
        const src = path.join(frameDir, frameFiles[sampleIndices[i]]);
        const dest = path.join(evidenceDir, `frame-${labels[i]}.png`);
        if (cropRect) {
          // Crop the committed still to the app window, matching the MP4.
          await sharp(src)
            .extract({
              left: cropRect.x,
              top: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            })
            .toFile(dest);
        } else {
          await fs.copyFile(src, dest);
        }
      }
    }
  } finally {
    // Stop the pump even on failure so it does not keep polling the bridge.
    await recording?.stop().catch(() => undefined);
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

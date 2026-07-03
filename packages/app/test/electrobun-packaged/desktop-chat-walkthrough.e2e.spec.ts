/**
 * Recorded packaged-desktop CHAT walkthrough (#12188 — desktop video lane).
 *
 * Desktop was the only platform with no walkthrough video (web has Playwright
 * `recordVideo`, Android has `adb screenrecord`, iOS has `simctl recordVideo`;
 * the Electrobun packaged harness only had single-PNG bridge screenshots). This
 * spec closes that gap: it boots the REAL packaged Electrobun app, starts the
 * bridge frame-pump recorder (`bridge-frame-recorder.ts`), then drives a real
 * chat-relevant flow entirely through the app's own event seams over the bridge
 * `eval` RPC — open the floating chat, type into the composer, send messages,
 * and step the sheet through its detents — and stitches the captured frames into
 * a real-time MP4.
 *
 * It drives the app the way the product does (the same `eliza:chat:open` /
 * `eliza:chat:prefill` / `eliza:tutorial:chat-control` window events the launcher
 * Messages tile, deep links, and the guided tour dispatch), not synthetic
 * mouse/keyboard — the WKWebView/WebKitGTK webview exposes no CDP for input
 * synthesis. Each step asserts the real DOM state transition it triggered, so a
 * green run proves the chat UI actually responded, and the recording is a
 * human-watchable record of the whole flow.
 *
 * Requires a prebuilt Electrobun binary (see playwright.electrobun.packaged.config.ts;
 * `ELIZA_TEST_PACKAGED_LAUNCHER_PATH` overrides the resolved launcher) and ffmpeg
 * on PATH for the stitch.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
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
const MIN_FRAME_COUNT = 20;

function decodeBridgePng(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
}

/** Lets the recorder capture a few frames of the state a step just produced. */
function dwell(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRendererShellReady(
  harness: PackagedDesktopHarness,
): Promise<void> {
  let last: EvalResult<{ ready: boolean; rootLength: number }> | undefined;
  await expect
    .poll(
      async () => {
        last = await harness.eval<
          EvalResult<{ ready: boolean; rootLength: number }>
        >(
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
        return last.ok && last.ready;
      },
      {
        timeout: process.env.CI ? 120_000 : 60_000,
        message: `Expected packaged desktop renderer to finish startup. Last: ${JSON.stringify(last)}`,
      },
    )
    .toBe(true);
}

/** Reads a compact snapshot of the chat overlay's DOM state via the bridge. */
async function readChatState(harness: PackagedDesktopHarness): Promise<{
  overlayPresent: boolean;
  composerPresent: boolean;
  pillPresent: boolean;
  composerValue: string;
  threadLineCount: number;
  transcriptText: string;
}> {
  const result = await harness.eval<
    EvalResult<{
      overlayPresent: boolean;
      composerPresent: boolean;
      pillPresent: boolean;
      composerValue: string;
      threadLineCount: number;
      transcriptText: string;
    }>
  >(
    `(() => {
      try {
        const overlay = document.querySelector('[data-testid="continuous-chat-overlay"]');
        const composer = document.querySelector('[data-testid="chat-composer-textarea"]');
        const pill = document.querySelector('[data-testid="chat-pill"]');
        const lines = Array.from(document.querySelectorAll('[data-testid="thread-line"]'));
        return {
          ok: true,
          overlayPresent: Boolean(overlay),
          composerPresent: Boolean(composer),
          pillPresent: Boolean(pill),
          composerValue: composer instanceof HTMLTextAreaElement ? composer.value : "",
          threadLineCount: lines.length,
          transcriptText: lines
            .map((line) => (line.textContent || "").replace(/\\s+/g, " ").trim())
            .join(" │ ")
            .slice(0, 600),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`readChatState failed: ${result.error}`);
  }
  return result;
}

async function dispatchWindowEvent(
  harness: PackagedDesktopHarness,
  name: string,
  detail?: unknown,
): Promise<void> {
  const detailLiteral =
    detail === undefined ? "undefined" : JSON.stringify(detail);
  const result = await harness.eval<EvalResult<Record<string, never>>>(
    `(() => {
      try {
        const detail = ${detailLiteral};
        window.dispatchEvent(
          detail === undefined
            ? new CustomEvent(${JSON.stringify(name)})
            : new CustomEvent(${JSON.stringify(name)}, { detail }),
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`dispatch ${name} failed: ${result.error}`);
  }
}

/** Presses Enter in the focused composer — the overlay's real send keybinding. */
async function sendComposerViaEnter(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const result = await harness.eval<EvalResult<Record<string, never>>>(
    `(() => {
      try {
        const ta = document.querySelector('[data-testid="chat-composer-textarea"]');
        if (!(ta instanceof HTMLTextAreaElement)) {
          return { ok: false, error: "composer textarea not found" };
        }
        ta.focus();
        ta.dispatchEvent(
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
    throw new Error(`send-via-enter failed: ${result.error}`);
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

    const frameDir = testInfo.outputPath("walkthrough-frames");
    const mp4Path = testInfo.outputPath("desktop-chat-walkthrough.mp4");
    const activeHarness = harness;
    recording = startBridgeFrameRecording({
      captureFrame: async () =>
        decodeBridgePng(await activeHarness.screenshot()),
      frameDir,
      mp4Path,
      fps: 10,
      label: "desktop-chat-walkthrough",
    });

    // 1. Resting home (chat collapsed to the floating pill).
    await dwell(1_200);

    // 2. Open the floating chat — the launcher "Messages" tile intent.
    await dispatchWindowEvent(activeHarness, "eliza:chat:open");
    await expect
      .poll(async () => (await readChatState(activeHarness)).composerPresent, {
        timeout: 20_000,
        message: "Expected eliza:chat:open to reveal the chat composer.",
      })
      .toBe(true);
    const opened = await readChatState(activeHarness);
    expect(opened.overlayPresent).toBe(true);
    await dwell(1_000);

    // 3. Type into the composer via the real prefill event.
    await dispatchWindowEvent(activeHarness, "eliza:chat:prefill", {
      text: FIRST_PROMPT,
      select: false,
    });
    await expect
      .poll(async () => (await readChatState(activeHarness)).composerValue, {
        timeout: 10_000,
        message: "Expected the composer to hold the prefilled prompt text.",
      })
      .toBe(FIRST_PROMPT);
    await dwell(1_000);

    // 4. Send it (Enter) — the user's message lands in the transcript, the
    // composer clears, and the mock streams a real assistant reply back.
    const beforeSend = await readChatState(activeHarness);
    await sendComposerViaEnter(activeHarness);
    await expect
      .poll(async () => (await readChatState(activeHarness)).threadLineCount, {
        timeout: 20_000,
        message: "Expected sending the first prompt to add a message row.",
      })
      .toBeGreaterThan(beforeSend.threadLineCount);
    const afterFirstSend = await readChatState(activeHarness);
    expect(afterFirstSend.composerValue).toBe("");
    expect(afterFirstSend.transcriptText).toContain(FIRST_PROMPT);
    // The streamed assistant reply arrives token-by-token; wait for it to land.
    await expect
      .poll(async () => (await readChatState(activeHarness)).transcriptText, {
        timeout: 20_000,
        message: "Expected a streamed assistant reply to reach the transcript.",
      })
      .toContain(REPLY_MARKER);
    await dwell(1_400);

    // 5. Second turn — prefill + send again (multi-message conversation on video).
    const beforeSecondSend = await readChatState(activeHarness);
    await dispatchWindowEvent(activeHarness, "eliza:chat:prefill", {
      text: SECOND_PROMPT,
      select: false,
    });
    await expect
      .poll(async () => (await readChatState(activeHarness)).composerValue, {
        timeout: 10_000,
      })
      .toBe(SECOND_PROMPT);
    await dwell(700);
    await sendComposerViaEnter(activeHarness);
    await expect
      .poll(async () => (await readChatState(activeHarness)).threadLineCount, {
        timeout: 20_000,
        message:
          "Expected sending the second prompt to add another message row.",
      })
      .toBeGreaterThan(beforeSecondSend.threadLineCount);
    const afterSecondSend = await readChatState(activeHarness);
    expect(afterSecondSend.transcriptText).toContain(SECOND_PROMPT);
    await dwell(1_400);

    // 6. Step the sheet through its detents — the real gesture-state transitions
    // (`eliza:tutorial:chat-control`) the guided tour drives, captured on video.
    await dispatchWindowEvent(activeHarness, "eliza:tutorial:chat-control", {
      action: "expand",
    });
    await expect
      .poll(async () => (await readChatState(activeHarness)).composerPresent, {
        timeout: 10_000,
      })
      .toBe(true);
    await dwell(1_000);

    await dispatchWindowEvent(activeHarness, "eliza:tutorial:chat-control", {
      action: "pill",
    });
    await expect
      .poll(async () => (await readChatState(activeHarness)).pillPresent, {
        timeout: 10_000,
        message:
          "Expected the pill detent to collapse the chat to the floating pill.",
      })
      .toBe(true);
    await dwell(1_000);

    await dispatchWindowEvent(activeHarness, "eliza:tutorial:chat-control", {
      action: "reset",
    });
    await dwell(1_000);

    const result = await recording.stop();
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
    for (const index of [
      0,
      Math.floor(frameFiles.length / 2),
      frameFiles.length - 1,
    ]) {
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
    for (const index of [
      0,
      Math.floor(frameFiles.length / 2),
      frameFiles.length - 1,
    ]) {
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
      const sampled = [
        0,
        Math.floor(frameFiles.length / 2),
        frameFiles.length - 1,
      ];
      for (let i = 0; i < sampled.length; i += 1) {
        await fs.copyFile(
          path.join(frameDir, frameFiles[sampled[i]]),
          path.join(evidenceDir, `frame-${["open", "mid", "end"][i]}.png`),
        );
      }
    }
  } finally {
    // Stop the pump even on failure so the child process is not left recording.
    await recording?.stop().catch(() => undefined);
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

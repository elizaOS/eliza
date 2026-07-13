/**
 * Packaged-desktop global voice hotkey e2e.
 *
 * Proves the desktop voice-hotkey spine end to end against the real packaged
 * shell: the `voice` shortcut (default CommandOrControl+Shift+M) is registered
 * with the OS at boot while `transcribe` stays unregistered (opt-in default);
 * a press summons the window and dispatches the renderer voice-control intent
 * (`converse-toggle`), which flips the shell controller's hands-free state —
 * observed on the composer mic control's aria-label/aria-pressed; a second
 * press flips it back off.
 *
 * `/shortcut/press` drives the SAME registered-shortcut callback the OS would
 * (GlobalShortcut → desktopShortcutPressed → main.tsx handler) but bypasses
 * OS-level accelerator registration itself. The darwin-only real-keystroke test
 * below closes that gap by injecting the actual accelerator through System
 * Events.
 *
 * Headless voice determinism: the packaged WebView has no microphone and no
 * SpeechRecognition engine, and a failed capture start deliberately rolls
 * hands-free back to rest (useShellController's startCapture catch). The spec
 * therefore stubs `getUserMedia` (synthesized AudioContext stream — a real
 * MediaStream with a live audio track, no device needed) and installs a
 * minimal `webkitSpeechRecognition` so the browser ASR backend starts cleanly
 * and the engaged state is stable enough to assert.
 *
 * Platform-parameterized: no darwin-only assumptions outside the real-keystroke
 * test, so the Windows packaged lane (run-desktop-packaged-windows.mjs) and a
 * future Linux xvfb lane can run it unchanged.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

const execFileAsync = promisify(execFile);

// The packaged desktop bottom-bar shell opens the ASSISTANT overlay
// (HomePill → AssistantOverlay → ChatSurface), not the mobile-style
// ChatOverlay glass composer — the voice observable is ChatSurface's mic
// GlassIconButton, whose aria-label flips "Start voice input" ⇄
// "Stop voice input" with capture state.
const STOP_VOICE_BUTTON = 'button[aria-label="Stop voice input"]';
const START_VOICE_BUTTON = 'button[aria-label="Start voice input"]';
const DEFAULT_VOICE_ACCELERATOR = "CommandOrControl+Shift+M";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

/**
 * Install (idempotently) the voice-control probe plus the headless capture
 * stubs. Returns the probe length so callers can diff around a press.
 */
async function armVoiceProbe(harness: PackagedDesktopHarness): Promise<void> {
  const result = await harness.eval<EvalResult<{ armed: boolean }>>(`(() => {
    try {
      const w = window;
      if (!w.__elizaVoiceHotkeyProbe) {
        w.__elizaVoiceHotkeyProbe = [];
        w.addEventListener("eliza:voice-control", (event) => {
          const detail = event && event.detail;
          w.__elizaVoiceHotkeyProbe.push(detail ? detail.command : null);
        });
      }
      // Synthesized mic: a MediaStreamDestination track satisfies getUserMedia
      // consumers without any audio device (WebKit supports this headless).
      if (!w.__elizaVoiceHotkeyMediaStubbed) {
        w.__elizaVoiceHotkeyMediaStubbed = true;
        const AudioCtx = w.AudioContext || w.webkitAudioContext;
        if (AudioCtx && navigator.mediaDevices) {
          navigator.mediaDevices.getUserMedia = async () => {
            const ctx = new AudioCtx();
            const dest = ctx.createMediaStreamDestination();
            const osc = ctx.createOscillator();
            osc.connect(dest);
            try { osc.start(); } catch (_) {}
            return dest.stream;
          };
        }
        // The shell gates hands-free engage on
        // navigator.permissions.query({name:"microphone"}) — headless packaged
        // WebKit reports denied (no TCC grant), which blocks engagement. The
        // controller re-probes authoritatively on every engage attempt, so a
        // granted stub here lets the press proceed.
        if (w.navigator?.permissions?.query) {
          const originalQuery = w.navigator.permissions.query.bind(
            w.navigator.permissions,
          );
          w.navigator.permissions.query = (descriptor) =>
            descriptor && descriptor.name === "microphone"
              ? Promise.resolve({
                  state: "granted",
                  onchange: null,
                  addEventListener() {},
                  removeEventListener() {},
                })
              : originalQuery(descriptor);
        }
        // Minimal SpeechRecognition so the browser ASR backend (the packaged
        // shell's fallback when local-inference ASR is not ready) starts
        // cleanly instead of throwing and rolling hands-free back to rest.
        if (!w.SpeechRecognition && !w.webkitSpeechRecognition) {
          w.webkitSpeechRecognition = class {
            constructor() {
              this.continuous = false;
              this.interimResults = false;
              this.lang = "en-US";
            }
            start() {
              if (typeof this.onstart === "function") {
                setTimeout(() => this.onstart(), 0);
              }
            }
            stop() {
              if (typeof this.onend === "function") {
                setTimeout(() => this.onend(), 0);
              }
            }
            abort() {
              if (typeof this.onend === "function") {
                setTimeout(() => this.onend(), 0);
              }
            }
          };
        }
      }
      return { ok: true, armed: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  if (!result.ok) throw new Error(`armVoiceProbe eval failed: ${result.error}`);
}

async function readProbe(harness: PackagedDesktopHarness): Promise<string[]> {
  const result = await harness.eval<
    EvalResult<{ commands: string[] }>
  >(`(() => {
    try {
      return { ok: true, commands: (window.__elizaVoiceHotkeyProbe || []).slice() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  if (!result.ok) throw new Error(`readProbe eval failed: ${result.error}`);
  return result.commands;
}

async function readVoiceButtons(
  harness: PackagedDesktopHarness,
): Promise<{ stopPresent: boolean; startPresent: boolean }> {
  const result = await harness.eval<
    EvalResult<{ stopPresent: boolean; startPresent: boolean }>
  >(`(() => {
    try {
      return {
        ok: true,
        stopPresent: Boolean(document.querySelector('${STOP_VOICE_BUTTON}')),
        startPresent: Boolean(document.querySelector('${START_VOICE_BUTTON}')),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  if (!result.ok)
    throw new Error(`readVoiceButtons eval failed: ${result.error}`);
  return result;
}

async function launchHarness(tempPrefix: string): Promise<{
  harness: PackagedDesktopHarness;
  api: MockApiServer;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first).",
  ).toBeTruthy();

  const api = await startMockApiServer({ firstRunComplete: true, port: 0 });
  const harness = new PackagedDesktopHarness({
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
  return { harness, api };
}

test("voice hotkey: registered by default, press toggles hands-free on/off; transcribe stays unregistered", async ({
  browserName: _browserName,
}) => {
  void _browserName;
  test.setTimeout(600_000);

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    ({ harness, api } = await launchHarness("eliza-desktop-voice-hotkey-"));
    const activeHarness = harness;

    // ── Registration defaults ────────────────────────────────────────────
    // Shortcut registration is renderer-driven (initializeDesktopShell over
    // the RPC bridge), which lands after shell-ready — poll rather than read
    // /state once, or the assertion races the renderer's boot tail.
    await expect
      .poll(
        async () => {
          const state = await activeHarness.getState();
          return (state.shell.shortcuts ?? []).map((s) => s.id);
        },
        {
          timeout: 120_000,
          message:
            "Expected the renderer to register the voice + chat-overlay shortcuts.",
        },
      )
      .toEqual(expect.arrayContaining(["voice", "chat-overlay"]));
    const shortcuts = (await activeHarness.getState()).shell.shortcuts ?? [];
    const voice = shortcuts.find((s) => s.id === "voice");
    expect(voice?.accelerator).toBe(DEFAULT_VOICE_ACCELERATOR);
    expect(
      shortcuts.find((s) => s.id === "transcribe"),
      "transcribe shortcut is opt-in (disabled by default)",
    ).toBeFalsy();

    // Pressing the unregistered transcribe id must 404 at the bridge — proves
    // the default-off state at the shortcut registry, not just in settings.
    await expect(activeHarness.pressShortcut("transcribe")).rejects.toThrow(
      /404|not registered/,
    );

    // ── Arm the probe + headless capture stubs, then press ──────────────
    // No pre-press composer assertion: the overlay rests at the PILL detent
    // where the composer (and its mic control) is not in the DOM. The press
    // itself is the entry point — engaging hands-free opens the chat surface,
    // which mounts the composer.
    await armVoiceProbe(activeHarness);
    await activeHarness.pressShortcut("voice");

    // The press summons the window…
    await activeHarness.waitForState(
      (s) => s.shell.windowVisible,
      "Expected the voice hotkey press to summon (show) the main window.",
      15_000,
    );
    // …and dispatches exactly one converse-toggle intent…
    await expect
      .poll(async () => await readProbe(activeHarness), {
        timeout: 15_000,
        message: "Expected one converse-toggle voice-control dispatch.",
      })
      .toEqual(["converse-toggle"]);
    // …which engages voice capture: the assistant overlay opens and the
    // ChatSurface mic flips to its active "Stop voice input" state.
    await expect
      .poll(async () => (await readVoiceButtons(activeHarness)).stopPresent, {
        timeout: 60_000,
        message:
          "Expected the assistant overlay's Stop-voice-input control once capture engaged.",
      })
      .toBe(true);

    // ── Second press: hands-free OFF ─────────────────────────────────────
    await activeHarness.pressShortcut("voice");
    await expect
      .poll(async () => await readProbe(activeHarness), {
        timeout: 15_000,
        message: "Expected a second converse-toggle dispatch.",
      })
      .toEqual(["converse-toggle", "converse-toggle"]);
    await expect
      .poll(async () => (await readVoiceButtons(activeHarness)).stopPresent, {
        timeout: 15_000,
        message: "Expected voice capture to disengage back to the resting state.",
      })
      .toBe(false);
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

// OS-level registration proof: /shortcut/press dispatches the registered
// callback directly, so it cannot detect a broken GlobalShortcut registration.
// This darwin-only, opt-in test injects the REAL accelerator (⌘⇧M) through
// System Events and asserts the same renderer observable flips.
//
// Requirements (why it is opt-in via ELIZA_E2E_REAL_HOTKEY=1):
//  - macOS Accessibility permission for the terminal/runner process
//    (System Settings → Privacy & Security → Accessibility), or osascript
//    fails with "not allowed to send keystrokes" (error -1719).
//  - A real window server session (not SSH-only/headless CI).
test("voice hotkey (macOS, real keystroke): OS-level accelerator reaches the shell", async ({
  browserName: _browserName,
}) => {
  void _browserName;
  test.skip(
    process.platform !== "darwin" || process.env.ELIZA_E2E_REAL_HOTKEY !== "1",
    "darwin-only; set ELIZA_E2E_REAL_HOTKEY=1 (needs Accessibility permission for the runner).",
  );
  test.setTimeout(600_000);

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    ({ harness, api } = await launchHarness("eliza-desktop-real-hotkey-"));
    const activeHarness = harness;

    const state = await activeHarness.getState();
    expect(
      (state.shell.shortcuts ?? []).find((s) => s.id === "voice")?.accelerator,
    ).toBe(DEFAULT_VOICE_ACCELERATOR);

    await armVoiceProbe(activeHarness);

    // A global shortcut fires regardless of app focus, but focus another app
    // deliberately: this proves the OS-level (not in-page keydown) path.
    await execFileAsync("osascript", [
      "-e",
      'tell application "Finder" to activate',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // CommandOrControl+Shift+M ⇒ ⌘⇧M on macOS.
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to keystroke "m" using {command down, shift down}',
    ]);

    await expect
      .poll(async () => await readProbe(activeHarness), {
        timeout: 20_000,
        message:
          "Expected the OS-injected accelerator to reach the shell as converse-toggle.",
      })
      .toEqual(["converse-toggle"]);
    await activeHarness.waitForState(
      (s) => s.shell.windowVisible,
      "Expected the OS-level press to summon the main window.",
      15_000,
    );

    // Toggle back off with a second real keystroke so the packaged app exits
    // in a resting voice state.
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to keystroke "m" using {command down, shift down}',
    ]);
    await expect
      .poll(async () => (await readProbe(activeHarness)).length, {
        timeout: 20_000,
        message: "Expected the second OS-injected press to dispatch as well.",
      })
      .toBe(2);
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

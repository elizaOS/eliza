/**
 * App-side half of the iOS keyboard app-handoff dictation (issue #12185,
 * sub 3 — the Wispr pattern). No iOS app extension may access the microphone,
 * so the ElizaKeyboard extension's mic button deep-links here
 * (`elizaos://keyboard-dictation?source=ios-keyboard&session=<id>`); this
 * module records + transcribes in the foreground app via the shared
 * voice-capture pipeline, publishes every stage (`recording` →
 * `transcribing` → `ready` | `error`) into the App Group through the native
 * `ElizaKeyboard` bridge, and prompts the user to switch back so the keyboard
 * can insert the transcript. A Live Activity mirrors the session when
 * available (reuses the #12503 `ElizaLiveActivity` bridge).
 *
 * Failure states are explicit: an unavailable bridge, a capture/ASR error
 * (engine not running included), and a no-speech result each surface both in
 * the in-app overlay AND as an `error` handoff record the keyboard renders —
 * never a silent no-op.
 */

import {
  getLiveActivityPlugin,
  type LiveActivityPluginLike,
} from "@elizaos/ui/bridge";
import {
  createVoiceCapture,
  type VoiceCaptureFactoryOptions,
  type VoiceCaptureHandle,
} from "@elizaos/ui/voice";
import appConfig from "../app.config";
import {
  getKeyboardDictationBridge,
  type KeyboardDictationBridge,
} from "./native/keyboard-dictation-bridge";

export type KeyboardDictationOutcome = "ready" | "error" | "cancelled";

export interface KeyboardDictationSession {
  /** Resolves with the terminal outcome once the session ends. */
  done: Promise<KeyboardDictationOutcome>;
  /** Stop recording and finalize the transcript (the overlay Done button). */
  finish(): void;
  /** Abort: clears the handoff record so the keyboard returns to idle. */
  cancel(): void;
}

/**
 * The Live Activity plugin accessor returns `{}` off iOS / on builds without
 * the bridge, so the session feature-detects `start`/`end` before calling.
 */
export type DictationLiveActivity = Partial<
  Pick<LiveActivityPluginLike, "start" | "end">
>;

export interface KeyboardDictationDeps {
  getBridge: () => KeyboardDictationBridge | null;
  createCapture: (options: VoiceCaptureFactoryOptions) => VoiceCaptureHandle;
  getLiveActivity: () => DictationLiveActivity;
  documentRef: () => Document | null;
}

const defaultDeps: KeyboardDictationDeps = {
  getBridge: getKeyboardDictationBridge,
  createCapture: createVoiceCapture,
  getLiveActivity: getLiveActivityPlugin,
  documentRef: () => (typeof document === "undefined" ? null : document),
};

// A dictation turn that produces no final transcript within this window is
// dead air; end it with an explicit no-speech error instead of running the mic
// forever while the user is back in the other app.
const SESSION_MAX_MS = 60_000;
const OVERLAY_ID = "eliza-keyboard-dictation-overlay";
const ACCENT = "#ff5800";
const LOG_PREFIX = `[${appConfig.appName}]`;

let activeSession: KeyboardDictationSession | null = null;

export function isKeyboardDictationSessionActive(): boolean {
  return activeSession !== null;
}

interface OverlayHandles {
  root: HTMLElement;
  status: HTMLElement;
  transcript: HTMLElement;
  doneButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  remove(): void;
}

function buildOverlay(doc: Document): OverlayHandles {
  doc.getElementById(OVERLAY_ID)?.remove();

  const root = doc.createElement("div");
  root.id = OVERLAY_ID;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Keyboard dictation");
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483000",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:14px",
    "padding:32px",
    "background:rgba(10,10,10,0.88)",
    "color:#fff",
    "font-family:-apple-system,system-ui,sans-serif",
    "text-align:center",
  ].join(";");

  const glyph = doc.createElement("div");
  glyph.textContent = "🎙";
  glyph.style.cssText = "font-size:44px;line-height:1";

  const status = doc.createElement("div");
  status.style.cssText = "font-size:19px;font-weight:600;max-width:32ch";

  const transcript = doc.createElement("div");
  transcript.style.cssText =
    "font-size:15px;color:rgba(255,255,255,0.75);min-height:1.4em;max-width:38ch";

  const row = doc.createElement("div");
  row.style.cssText = "display:flex;gap:12px;margin-top:10px";

  const doneButton = doc.createElement("button");
  doneButton.type = "button";
  doneButton.textContent = "Done";
  doneButton.style.cssText = `padding:12px 28px;border-radius:999px;border:none;background:${ACCENT};color:#fff;font-size:16px;font-weight:600`;

  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.style.cssText =
    "padding:12px 28px;border-radius:999px;border:1px solid rgba(255,255,255,0.35);background:transparent;color:#fff;font-size:16px";

  row.append(doneButton, cancelButton);
  root.append(glyph, status, transcript, row);
  doc.body.appendChild(root);

  return {
    root,
    status,
    transcript,
    doneButton,
    cancelButton,
    remove: () => root.remove(),
  };
}

/**
 * Start (or restart) the app-side dictation session for the
 * `keyboard-dictation` deep link. A second launch while a session is live
 * cancels the old one — the user re-tapped the keyboard mic.
 */
export function startKeyboardDictationSession(
  params: URLSearchParams,
  deps: KeyboardDictationDeps = defaultDeps,
): KeyboardDictationSession {
  activeSession?.cancel();

  const sessionId =
    params.get("session")?.trim() ||
    (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`);
  const source = params.get("source") ?? "ios-keyboard";
  const log = (message: string, ...rest: unknown[]) =>
    console.log(
      `${LOG_PREFIX} [KeyboardDictation] ${message} (source=${source} session=${sessionId})`,
      ...rest,
    );

  const bridge = deps.getBridge();
  const doc = deps.documentRef();
  const overlay = doc ? buildOverlay(doc) : null;

  let settled = false;
  let capture: VoiceCaptureHandle | null = null;
  let liveActivityStarted = false;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let finalText = "";
  let resolveDone!: (outcome: KeyboardDictationOutcome) => void;
  const done = new Promise<KeyboardDictationOutcome>((resolve) => {
    resolveDone = resolve;
  });
  // Bridge writes are serialized so a late `recording` can never overwrite the
  // terminal `ready`/`error` record the keyboard is about to read.
  let writeChain: Promise<unknown> = Promise.resolve();

  const liveActivity = deps.getLiveActivity();
  function startLiveActivity(): void {
    if (typeof liveActivity.start !== "function") return;
    liveActivity
      .start({ sessionTitle: "Keyboard dictation", phase: "recording" })
      .then(() => {
        liveActivityStarted = true;
      })
      .catch((error: unknown) => {
        // error-policy:J4 the Live Activity is an ancillary surface (user sees
        // the in-app overlay); dictation proceeds and the failure is logged.
        log("Live Activity unavailable", error);
      });
  }

  function endLiveActivity(): void {
    if (!liveActivityStarted || typeof liveActivity.end !== "function") return;
    liveActivityStarted = false;
    liveActivity.end({}).catch((error: unknown) => {
      // error-policy:J6 best-effort teardown of the ancillary Live Activity.
      log("Failed to end Live Activity", error);
    });
  }

  function writeState(status: "recording" | "transcribing"): Promise<boolean> {
    if (!bridge) return Promise.resolve(false);
    const write = writeChain.then(() =>
      bridge.setDictationState({ status, sessionId }),
    );
    // error-policy:J5 the serialization accumulator only sequences later writes;
    // this write's own rejection is observed by the `write.then(ok, err)` below.
    writeChain = write.catch(() => undefined);
    return write.then(
      () => true,
      (error: unknown) => {
        fail(
          `Keyboard handoff unavailable: ${error instanceof Error ? error.message : String(error)}`,
          { writeErrorRecord: false },
        );
        return false;
      },
    );
  }

  function teardown(): void {
    if (maxTimer) clearTimeout(maxTimer);
    maxTimer = null;
    capture?.dispose();
    capture = null;
    endLiveActivity();
  }

  function settle(outcome: KeyboardDictationOutcome): void {
    settled = true;
    activeSession = null;
    teardown();
    resolveDone(outcome);
  }

  function succeed(text: string): void {
    if (settled) return;
    if (!bridge) return;
    writeChain = writeChain
      .then(() =>
        bridge.setDictationState({
          status: "ready",
          transcript: text,
          sessionId,
        }),
      )
      .then(
        () => {
          log("Transcript published to the App Group");
          if (overlay) {
            overlay.status.textContent =
              "Transcript ready — switch back to your keyboard to insert it.";
            overlay.transcript.textContent = text;
            overlay.doneButton.style.display = "none";
            overlay.cancelButton.textContent = "Close";
          }
          settle("ready");
        },
        (error: unknown) => {
          fail(
            `Keyboard handoff failed: ${error instanceof Error ? error.message : String(error)}`,
            { writeErrorRecord: false },
          );
        },
      );
  }

  function fail(
    message: string,
    { writeErrorRecord = true }: { writeErrorRecord?: boolean } = {},
  ): void {
    if (settled) return;
    log(`Dictation failed: ${message}`);
    if (overlay) {
      overlay.status.textContent = message;
      overlay.transcript.textContent = "";
      overlay.doneButton.style.display = "none";
      overlay.cancelButton.textContent = "Close";
    }
    if (writeErrorRecord && bridge) {
      writeChain = writeChain
        .then(() =>
          bridge.setDictationState({
            status: "error",
            errorMessage: message,
            sessionId,
          }),
        )
        .catch((error: unknown) => {
          // error-policy:J1 terminal boundary: the error state itself could not
          // be handed to the keyboard; the overlay above already shows it.
          log("Failed to publish error record", error);
        })
        .then(() => settle("error"));
      return;
    }
    settle("error");
  }

  const session: KeyboardDictationSession = {
    done,
    finish: () => {
      if (settled || !capture) return;
      if (overlay) overlay.status.textContent = "Transcribing…";
      void writeState("transcribing");
      capture.stop().then(
        () => {
          // The final transcript segment lands via onTranscript before/at
          // stop() resolution; if none arrived, the turn had no speech.
          if (!settled && !finalText) {
            fail("No speech detected. Try again.");
          }
        },
        (error: unknown) => {
          if (!settled) {
            fail(
              `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      );
    },
    cancel: () => {
      if (settled) return;
      log("Dictation cancelled");
      if (bridge) {
        void bridge.clearDictationState().catch((error: unknown) => {
          // error-policy:J6 best-effort cleanup; a stale record is discarded by
          // the keyboard's freshness window.
          log("Failed to clear handoff record on cancel", error);
        });
      }
      overlay?.remove();
      settle("cancelled");
    },
  };
  activeSession = session;

  if (overlay) {
    overlay.status.textContent = "Listening… speak now.";
    overlay.transcript.textContent = "";
    overlay.doneButton.addEventListener("click", () => session.finish());
    overlay.cancelButton.addEventListener("click", () => {
      if (settled) {
        overlay.remove();
      } else {
        session.cancel();
      }
    });
  }

  if (!bridge) {
    fail(
      "Keyboard dictation is only available in the iOS app (the ElizaKeyboard bridge is missing).",
      { writeErrorRecord: false },
    );
    return session;
  }

  log("Starting keyboard dictation session");
  startLiveActivity();

  capture = deps.createCapture({
    finalizeOnStop: true,
    onTranscript: (segment) => {
      if (settled) return;
      if (!segment.final) {
        if (overlay) overlay.transcript.textContent = segment.text;
        return;
      }
      finalText = finalText ? `${finalText} ${segment.text}` : segment.text;
      succeed(finalText);
    },
    onStateChange: (state, error) => {
      if (settled) return;
      if (state === "error") {
        fail(
          `Speech capture failed: ${error?.message ?? "unknown error"}. Check that voice input is available on this device.`,
        );
      }
    },
  });

  void writeState("recording").then((ok) => {
    if (!ok || settled || !capture) return;
    capture.start().catch((error: unknown) => {
      if (!settled) {
        fail(
          `Couldn't start recording: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  });

  maxTimer = setTimeout(() => {
    if (!settled) session.finish();
  }, SESSION_MAX_MS);

  return session;
}

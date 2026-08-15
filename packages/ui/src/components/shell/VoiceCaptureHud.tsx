/**
 * VoiceCaptureHud — an on-screen trace of the last voice-capture breadcrumbs so
 * a "tapped the mic, then crickets" report is diagnosable from a phone
 * screenshot instead of a devtools console the installed PWA doesn't have.
 *
 * It is the voice-capture sibling of {@link ../shell/BuildBadge}: local Vite
 * development shows it immediately, stamped device builds read
 * `/build-info.json`, and unstamped production bundles render nothing. That
 * keeps the "screenshot is ground truth" loop available on laptops and phones
 * without exposing a diagnostic overlay in production.
 *
 * The HUD subscribes to the unconditional breadcrumb ring in
 * {@link ../../utils/voice-capture-debug} and renders the last ~8 steps with
 * millisecond offsets from the `mic:tap` that began the trace, e.g.
 *
 *   `mic:tap → gum:req → gum:ok(120ms) → ctx:running → rec:start → post:200 → txt`
 *
 * or wherever it dies:
 *
 *   `mic:tap → gum:err(NotAllowedError)`   (permission denied)
 *   `mic:tap → gum:ok → ctx:suspended!`    (AudioContext never resumed)
 *   `mic:tap → … → wav:SILENT`             (silence guard no-op'd)
 *   `mic:tap → … → post:403`               (cloud STT rejected)
 *   `mic:tap`  (nothing after → provider branch/handler never reached capture)
 *
 * Monospace, tiny, high-contrast, bottom-anchored above the composer, auto-
 * scrolled to the newest event so the failing step is always visible.
 *
 * The ring is populated whether or not `eliza:voice:debug` is set, so on a
 * stamped sol-dev build the HUD works with zero on-device console setup. The
 * `× ` dismiss hides it for the session (sessionStorage) so it never nags real
 * use, matching BuildBadge's dismissal contract.
 */

import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Z_BUILD_BADGE } from "../../lib/floating-layers";
import {
  subscribeVoiceCaptureBreadcrumbs,
  type VoiceCaptureBreadcrumb,
} from "../../utils/voice-capture-debug";

const BUILD_INFO_URL = "/build-info.json";
const DISMISS_KEY = "eliza.voiceHud.dismissed";

interface BuildInfo {
  commit?: string;
  builtAt?: string;
  label?: string;
}

function readSessionDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage unavailable (private mode / quota) — in-memory hide still works.
  }
}

/**
 * Compact a breadcrumb's structured detail into the tiny parenthetical the HUD
 * line shows, e.g. `gum:err` + `{ name: "NotAllowedError" }` → `NotAllowedError`.
 * Picks the single most diagnostic field (error name/message, http status, byte
 * size, provider, state) so the line stays phone-narrow. Returns "" when there
 * is nothing worth showing.
 */
function detailToken(step: string, detail?: Record<string, unknown>): string {
  if (!detail) return "";
  const pick = (k: string): string | undefined => {
    const v = detail[k];
    if (v == null) return undefined;
    return typeof v === "string" ? v : String(v);
  };
  if (step === "realtime:turn-latency") {
    const outcome = pick("outcome");
    const latency = (
      key: "sttToModelMs" | "sttToAudioMs" | "modelToAudioMs",
      label: string,
    ): string | null => {
      const value = pick(key);
      return value && value !== "not_measured" ? `${label} ${value}ms` : null;
    };
    return [
      outcome,
      latency("sttToModelMs", "S→M"),
      latency("sttToAudioMs", "S→A"),
      latency("modelToAudioMs", "M→A"),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (step === "realtime:trace-complete") {
    const outcome = pick("outcome");
    const complete = pick("evidenceComplete") === "true";
    const missing = detail.missingMarks;
    const missingToken =
      Array.isArray(missing) && missing.length > 0
        ? `missing:${missing.join(",")}`
        : null;
    const latency = (key: string, label: string): string | null => {
      const value = pick(key);
      return value && value !== "not_measured" ? `${label} ${value}ms` : null;
    };
    return [
      outcome,
      complete ? "evidence:complete" : (missingToken ?? "evidence:partial"),
      latency("acousticEndToFinalMs", "E→STT"),
      latency("commitToModelMs", "C→M"),
      latency("speakableToTtsByteMs", "S→TTS"),
      latency("acousticEndToAudibleMs", "E→A"),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (step === "realtime:capture-ready") {
    const backend = pick("backend");
    const frameMs = pick("frameMs");
    const contextHz = pick("contextHz");
    const grantedHz = pick("grantedHz");
    const channels = pick("channels");
    const enabled = (key: string, label: string): string | null => {
      const value = pick(key);
      return value === "true" || value === "false"
        ? `${label}:${value === "true" ? "on" : "off"}`
        : null;
    };
    return [
      backend,
      frameMs ? `${frameMs}ms` : null,
      contextHz ? `ctx${contextHz}Hz` : null,
      grantedHz ? `mic${grantedHz}Hz` : null,
      channels ? `${channels}ch` : null,
      enabled("echoCancellation", "AEC"),
      enabled("noiseSuppression", "NS"),
      enabled("autoGainControl", "AGC"),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (step === "realtime:playback-ready") {
    const backend = pick("backend");
    const requestedHz = pick("requestedHz");
    const actualHz = pick("actualHz");
    const conversion = pick("conversion");
    return [
      backend,
      requestedHz && actualHz ? `${requestedHz}→${actualHz}Hz` : null,
      conversion,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (
    step === "realtime:playback-started" ||
    step === "realtime:playback-drained"
  ) {
    const sequence = pick("sequence");
    return sequence ? `seq ${sequence}` : "";
  }
  // Error-ish steps: surface the error name/message.
  const err = pick("name") ?? pick("error") ?? pick("reason");
  if (err && (step.includes("err") || step.includes("fail"))) return err;
  // HTTP steps: status.
  const status = pick("status");
  if (status && step.startsWith("post")) return status;
  // WAV steps: silent flag + byte size (both matter for the crickets story).
  if (step.startsWith("wav")) {
    const silent = pick("silent");
    const bytes = pick("bytes");
    if (silent && bytes) return `${silent},${bytes}b`;
    if (silent) return silent;
    if (bytes) return `${bytes}b`;
  }
  // getUserMedia resolve: the round-trip ms (mirrors the mandate's gum:ok(120ms)).
  if (step === "gum:ok") {
    const ms = pick("ms");
    if (ms) return `${ms}ms`;
  }
  // AudioContext transitions: the state.
  const state = pick("state");
  if (state && step.startsWith("ctx")) return state;
  // Provider selection: which backend + why.
  const provider = pick("provider") ?? pick("backend") ?? pick("asrProvider");
  if (provider && step.startsWith("provider")) return provider;
  // start:enter fork witness: the resolved ASR provider that decides routing.
  if (step === "start:enter") {
    const asr = pick("asrProvider");
    if (asr) return asr;
  }
  // mic:branch / mic:noop: the action/reason taken.
  if (step.startsWith("mic:")) {
    const action = pick("action") ?? pick("reason");
    if (action) return action;
  }
  // Recorder data / stop: first-chunk length / submit flag.
  const chunk = pick("chunk") ?? pick("frames");
  if (chunk && step.startsWith("rec")) return chunk;
  // Transcript: char count.
  if (step === "txt" || step === "post:200") {
    const chars = pick("chars");
    if (chars) return `${chars}ch`;
  }
  // Generic fallback: the first scalar value.
  const bytes = pick("bytes");
  const err2 = err ?? status ?? bytes ?? state ?? provider ?? chunk;
  return err2 ?? "";
}

/** A rendered HUD line: the step label, ms offset from tap, and detail token. */
interface HudLine {
  seq: number;
  step: string;
  /** ms since the `mic:tap` that began this trace (or since the first event). */
  offsetMs: number;
  token: string;
  /** True when this step reads as a failure/terminal (rendered in alert red). */
  bad: boolean;
}

function isBadStep(step: string, token: string): boolean {
  if (step.includes("err") || step.includes("fail")) return true;
  if (step === "ctx:suspended" || step.endsWith("!")) return true;
  if (step.startsWith("wav") && token.toUpperCase().includes("SILENT")) {
    return true;
  }
  if (step.startsWith("post")) {
    const code = Number.parseInt(token, 10);
    if (Number.isFinite(code) && code >= 400) return true;
  }
  if (step === "pause:cancel") return true;
  if (
    step === "realtime:trace-complete" &&
    !token.includes("evidence:complete")
  ) {
    return true;
  }
  return false;
}

function toLines(ring: readonly VoiceCaptureBreadcrumb[]): HudLine[] {
  if (ring.length === 0) return [];
  // Offsets are measured from the most recent `mic:tap` (the trace start) so
  // each step reads as "N ms after the tap". Fall back to the first event if a
  // trace somehow has no tap (a breadcrumb fired outside a tap-initiated flow).
  let baseMs = ring[0]?.atMs ?? 0;
  for (const b of ring) {
    if (b.step === "mic:tap") {
      baseMs = b.atMs;
      break;
    }
  }
  return ring.map((b) => {
    const token = detailToken(b.step, b.detail);
    return {
      seq: b.seq,
      step: b.step,
      offsetMs: Math.max(0, Math.round(b.atMs - baseMs)),
      token,
      bad: isBadStep(b.step, token),
    };
  });
}

interface VoiceCaptureHudProps {
  /** Test seam; production callers use Vite's compile-time development flag. */
  localDev?: boolean;
}

export function VoiceCaptureHud({
  localDev = import.meta.env.DEV,
}: VoiceCaptureHudProps = {}) {
  const [stamped, setStamped] = useState<boolean>(localDev);
  const [dismissed, setDismissed] = useState<boolean>(() =>
    readSessionDismissed(),
  );
  const [ring, setRing] = useState<readonly VoiceCaptureBreadcrumb[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Stamped-builds-only gate — identical to BuildBadge: a live
  // `/build-info.json` means this is a sol-dev / CI build (the debug surface),
  // so the HUD renders; production bundles without the stamp render nothing.
  useEffect(() => {
    if (dismissed || localDev) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(BUILD_INFO_URL, { cache: "no-store" });
        if (!res.ok) return;
        // Presence + parseability of the stamp is the gate; the label itself is
        // shown by BuildBadge, not here.
        const info = (await res.json()) as BuildInfo;
        const ok =
          !!info &&
          (typeof info.commit === "string" || typeof info.label === "string");
        if (!cancelled && ok) setStamped(true);
      } catch {
        // No build info (production) — stay hidden silently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dismissed, localDev]);

  // Subscribe to the breadcrumb ring once the HUD is going to render. The
  // subscription fires immediately with the current ring so a late mount still
  // shows the existing trace. Auto-scroll to the newest event on each update
  // (folded into the subscription so the scroll re-runs exactly when a
  // breadcrumb lands, with no synthetic effect dependency).
  useEffect(() => {
    if (dismissed || !stamped) return;
    return subscribeVoiceCaptureBreadcrumbs((next) => {
      setRing(next);
      // Defer to after paint so scrollHeight reflects the appended line.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }, [dismissed, stamped]);

  const lines = useMemo(() => toLines(ring), [ring]);

  const dismiss = useCallback(() => {
    writeSessionDismissed();
    setDismissed(true);
  }, []);

  if (dismissed || !stamped || lines.length === 0) return null;

  return (
    <div
      data-testid="voice-capture-hud"
      data-aesthetic-overlay-ignore="true"
      className="pointer-events-none fixed inset-x-0 flex justify-center px-2"
      style={{
        // Anchored above the composer: sit just above the safe-area bottom so
        // it clears the on-screen composer/keyboard chrome. High z so a mic
        // overlay doesn't occlude the very trace that explains the overlay.
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 4.5rem)",
        zIndex: Z_BUILD_BADGE,
      }}
    >
      <div className="pointer-events-auto flex max-w-[calc(100%-0.5rem)] items-stretch gap-1 rounded-md border border-border bg-black/85 px-1.5 py-1 shadow-lg">
        <div
          ref={scrollRef}
          data-testid="voice-capture-hud-lines"
          className="max-h-24 overflow-auto font-mono text-3xs leading-tight text-white/90"
        >
          {lines.map((line) => (
            <div
              key={line.seq}
              data-testid="voice-capture-hud-line"
              className="flex items-baseline gap-1 whitespace-nowrap tabular-nums"
            >
              <span className="text-white/60">+{line.offsetMs}</span>
              <span className={line.bad ? "text-red-400" : "text-emerald-300"}>
                {line.step}
              </span>
              {line.token ? (
                <span className={line.bad ? "text-red-300" : "text-white/70"}>
                  ({line.token})
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          data-testid="voice-capture-hud-dismiss"
          title="Hide voice trace for this session"
          aria-label="Hide voice capture trace for this session"
          onClick={dismiss}
          className="shrink-0 self-start text-white/50 hover:text-white"
        >
          <X aria-hidden="true" className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}

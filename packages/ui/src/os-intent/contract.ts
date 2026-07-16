/**
 * `eliza.os-intent/v1` — the one structural intent vocabulary that unifies how
 * chat, voice, and transcription are launched across every entry point: iOS App
 * Intents / Siri, Android app-actions + shortcuts, desktop deep links, tray and
 * widget controls, notification taps, and in-app invocations. A launch surface
 * emits a typed {@link OsIntent}; the routing authority (`router.ts`) decides —
 * from STRUCTURAL fields only — whether to dispatch it to the one shared shell
 * controller, dedupe it, block it on an unmet prerequisite, gate an auto-start on
 * consent, or degrade visibly on a device that cannot honor it.
 *
 * Design rules that keep routing deterministic and safe:
 *   - Behavior derives from the discriminant `type`, the declared prerequisites,
 *     and the routing context — NEVER from prompt or transcript text. The native
 *     surfaces historically emitted a free-form `action` string
 *     (`ask`/`chat`/`voice`/…); that string is untrusted input mapped to a typed
 *     intent at the decode boundary (`decode.ts`) and never inspected again.
 *   - `intentId` is the stable idempotency key. The same launch — redelivered by
 *     a retried deep link, a re-tapped notification, a second window, or a
 *     restored/crashed-then-reopened session — carries the same `intentId`, so
 *     the authority applies it exactly once.
 *   - Auto-start intents (mic capture) are consent-gated and reversible: a
 *     `start-*` intent only fires with recorded consent, and every `start-*` has
 *     a matching `stop-*` that is always allowed (you can always turn capture
 *     off).
 *
 * This module is pure type + constant declarations (runtime validation lives in
 * `decode.ts`, routing in `router.ts`) so it is safe to import from any layer,
 * native bridge shim included.
 */
import type { ImageAttachment } from "../api/client-types-chat";

/** Versioned schema identifier carried by an intent envelope. */
export const OS_INTENT_SCHEMA = "eliza.os-intent/v1" as const;
export type OsIntentSchema = typeof OS_INTENT_SCHEMA;

/**
 * Where an intent originated. Grouped by transport so the router can apply
 * transport-specific policy (e.g. a background notification tap may not
 * auto-start the mic on iOS). Every value a native surface stamps into the
 * `source` query key of an `elizaos://…` deep link appears here.
 */
export type IntentSource =
  | "ios-app-intent"
  | "ios-app-shortcuts"
  | "ios-widget"
  | "siri"
  | "macos-shortcuts"
  | "macos-siri"
  | "android-app-actions"
  | "android-assist"
  | "android-static-shortcut"
  | "android-quick-settings"
  | "desktop-deep-link"
  | "desktop-tray"
  | "desktop-hotkey"
  | "notification"
  | "assistant-entry"
  | "in-app";

/** Every recognized source, for the decoder's known-source gate. */
export const INTENT_SOURCES: readonly IntentSource[] = [
  "ios-app-intent",
  "ios-app-shortcuts",
  "ios-widget",
  "siri",
  "macos-shortcuts",
  "macos-siri",
  "android-app-actions",
  "android-assist",
  "android-static-shortcut",
  "android-quick-settings",
  "desktop-deep-link",
  "desktop-tray",
  "desktop-hotkey",
  "notification",
  "assistant-entry",
  "in-app",
] as const;

/** The shell surface an intent addresses. Derived structurally, never parsed. */
export type IntentTarget = "chat" | "voice" | "transcription";

// ── Intents (the typed launch vocabulary) ──────────────────────────────

/** Fields every intent carries: its dedupe identity and provenance. */
interface IntentBase {
  /** Stable idempotency key. Identical across every redelivery of one launch. */
  intentId: string;
  source: IntentSource;
  /** Epoch ms the launch was issued; drives staleness rejection when present. */
  issuedAt?: number;
}

/** Bring the chat surface forward without sending anything. */
export interface OpenChatIntent extends IntentBase {
  type: "open-chat";
}

/** Open chat and submit `text` as a turn (App-Intent "ask", assist smart-reply). */
export interface SendIntent extends IntentBase {
  type: "send";
  text: string;
  /** `VOICE_DM` requests a spoken reply; defaults to a typed `DM` turn. */
  channelType?: "DM" | "VOICE_DM";
  images?: ImageAttachment[];
  metadata?: Record<string, unknown>;
}

/**
 * Auto-start microphone capture. `converse` sends a spoken turn; `dictate` routes
 * the final transcript to the composer draft without sending. Consent-gated.
 */
export interface StartVoiceIntent extends IntentBase {
  type: "start-voice";
  mode: "converse" | "dictate";
}

/** Stop microphone capture. Always permitted (the reverse of {@link StartVoiceIntent}). */
export interface StopVoiceIntent extends IntentBase {
  type: "stop-voice";
}

/**
 * Auto-start long-form transcription: continuous capture into one recording
 * session with the agent held quiet until an exit phrase. Consent-gated.
 */
export interface StartTranscriptionIntent extends IntentBase {
  type: "start-transcription";
}

/** Stop transcription and the mic. Always permitted (the reverse of start). */
export interface StopTranscriptionIntent extends IntentBase {
  type: "stop-transcription";
}

/** Reopen the ongoing conversation (a notification tap / "resume" affordance). */
export interface ContinueConversationIntent extends IntentBase {
  type: "continue-conversation";
}

export type OsIntent =
  | OpenChatIntent
  | SendIntent
  | StartVoiceIntent
  | StopVoiceIntent
  | StartTranscriptionIntent
  | StopTranscriptionIntent
  | ContinueConversationIntent;

export type OsIntentType = OsIntent["type"];

/** Every recognized intent discriminant, for the decoder's known-type gate. */
export const OS_INTENT_TYPES: readonly OsIntentType[] = [
  "open-chat",
  "send",
  "start-voice",
  "stop-voice",
  "start-transcription",
  "stop-transcription",
  "continue-conversation",
] as const;

/** The shell surface each intent type addresses. */
export const INTENT_TARGET: Record<OsIntentType, IntentTarget> = {
  "open-chat": "chat",
  send: "chat",
  "start-voice": "voice",
  "stop-voice": "voice",
  "start-transcription": "transcription",
  "stop-transcription": "transcription",
  "continue-conversation": "chat",
};

/**
 * Intent types that BEGIN microphone capture. These are the only ones subject to
 * the consent gate and the foreground/permission/support prerequisites; the
 * matching `stop-*` intents are never auto-start (turning capture off is always
 * allowed, so a stuck session is always recoverable).
 */
export const AUTO_START_INTENT_TYPES: ReadonlySet<OsIntentType> = new Set([
  "start-voice",
  "start-transcription",
]);

// ── Prerequisites ──────────────────────────────────────────────────────

/**
 * A condition the routing context must satisfy before an intent can fire.
 * Checked structurally against {@link RoutingContext}; an unmet prerequisite
 * yields a `blocked`/`degraded` outcome, never a silent no-op.
 *
 *   - `session`     an unexpired agent session/auth is available.
 *   - `unlocked`    the device is unlocked (a locked device cannot capture).
 *   - `foreground`  the app is foreground (platforms forbid background capture).
 *   - `microphone`  microphone permission is granted.
 *   - `voice-capture`  the platform supports voice capture at all (else degrade).
 */
export type IntentPrerequisite =
  | "session"
  | "unlocked"
  | "foreground"
  | "microphone"
  | "voice-capture";

/** The prerequisites each intent type declares, checked in `router.ts`. */
export const INTENT_PREREQUISITES: Record<
  OsIntentType,
  readonly IntentPrerequisite[]
> = {
  "open-chat": ["session"],
  send: ["session"],
  "start-voice": ["session", "unlocked", "foreground", "microphone", "voice-capture"],
  "stop-voice": [],
  "start-transcription": ["unlocked", "foreground", "microphone", "voice-capture"],
  "stop-transcription": [],
  "continue-conversation": ["session"],
};

// ── Controller commands (the routing output) ───────────────────────────

/**
 * The subset of the shared shell-controller command surface (#16442) that OS
 * intents produce. Kept structurally identical to that union's members so ONE
 * executor drives the single live engine (`apply-command.ts` → `ShellController`)
 * and no intent ever spins up a second chat/voice session. Routing emits these;
 * the authority never touches the DOM or the mic directly.
 */
export type IntentControllerCommand =
  | { kind: "open" }
  | {
      kind: "send";
      text: string;
      channelType?: "DM" | "VOICE_DM";
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
    }
  | { kind: "startRecording"; intent: "converse" | "dictate" }
  | { kind: "stopRecording" }
  | { kind: "toggleTranscriptionMode" }
  | { kind: "stopTranscriptionAndMic" };

export type IntentControllerCommandKind = IntentControllerCommand["kind"];

// ── Outcomes (the typed result of routing) ─────────────────────────────

/** Recoverable reason an intent could not fire now; the user/agent can fix it
 *  and the same `intentId` will route on retry (blocked intents are not recorded
 *  as applied). */
export type IntentBlockReason =
  | "unauthenticated"
  | "auth-expired"
  | "locked"
  | "backgrounded"
  | "microphone-denied";

/** Reason a device fundamentally cannot honor an intent; the shell must show a
 *  visible unavailable state rather than pretend it ran. */
export type IntentDegradeReason = "voice-unsupported" | "sandboxed";

/**
 * The typed result of routing one intent. Exactly one status; every non-`routed`
 * status is observable so a caller can render a real state (three-state rule)
 * instead of a silent success.
 */
export type IntentOutcome =
  | {
      status: "routed";
      intentId: string;
      intentType: OsIntentType;
      target: IntentTarget;
      commands: IntentControllerCommand[];
    }
  | { status: "duplicate"; intentId: string; firstAppliedAt: number }
  | { status: "stale"; intentId: string; ageMs: number; maxAgeMs: number }
  | {
      status: "blocked";
      intentId: string;
      intentType: OsIntentType;
      reason: IntentBlockReason;
      missing: IntentPrerequisite[];
    }
  | {
      status: "consent-required";
      intentId: string;
      intentType: OsIntentType;
      target: IntentTarget;
    }
  | {
      status: "degraded";
      intentId: string;
      intentType: OsIntentType;
      reason: IntentDegradeReason;
    };

export type IntentOutcomeStatus = IntentOutcome["status"];

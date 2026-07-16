/**
 * The routing authority: the one place a decoded {@link OsIntent} becomes a typed
 * {@link IntentOutcome} and, when it fires, the commands to run against the single
 * shared shell controller. Every decision is STRUCTURAL — it switches on the
 * intent discriminant and reads {@link RoutingContext}; it never inspects prompt
 * or transcript text (the free-form native `action` string was already resolved
 * to a typed intent at the decode boundary).
 *
 * The fixed evaluation order below is the contract callers rely on. Only a
 * `routed` intent is recorded in the dedupe store, so a `blocked` intent retried
 * after the user fixes the prerequisite (grants mic, unlocks, re-auths) still
 * routes — the block is observable and recoverable, never a silent dead end.
 */
import {
  AUTO_START_INTENT_TYPES,
  INTENT_PREREQUISITES,
  INTENT_TARGET,
  type IntentBlockReason,
  type IntentControllerCommand,
  type IntentDegradeReason,
  type IntentOutcome,
  type IntentPrerequisite,
  type IntentTarget,
  type OsIntent,
  type OsIntentType,
} from "./contract";
import type { IntentDedupeStore } from "./dedupe";

/** Microphone-permission state, mirroring the shell's proactive probe. `denied`
 *  is the only hard block; `prompt`/`unknown` proceed to a capture-time prompt. */
export type MicPermissionState = "granted" | "denied" | "prompt" | "unknown";

/** Session/auth state gating chat + agent-backed intents. */
export type AuthState = "authenticated" | "unauthenticated" | "expired";

/**
 * Everything the authority reads to route an intent — the live device/auth/
 * capability/consent state at the moment of routing. All structural; no text.
 */
export interface RoutingContext {
  /** Epoch ms; the clock for staleness and dedupe TTL. */
  now: number;
  auth: AuthState;
  device: {
    /** A locked device cannot reveal chat or open the mic. */
    locked: boolean;
    /** Platforms forbid starting capture while backgrounded. */
    foreground: boolean;
  };
  capabilities: {
    /** The platform can capture voice at all. False → visible voice degrade. */
    voiceCapture: boolean;
    /** A sandbox forbids the capture surface entirely → visible degrade. */
    sandboxed: boolean;
    microphone: MicPermissionState;
  };
  consent: {
    /** The user has enabled auto-starting voice capture from a launch. */
    autoStartVoice: boolean;
    /** The user has enabled auto-starting transcription from a launch. */
    autoStartTranscription: boolean;
  };
  /** Reject intents whose `issuedAt` is older than this (ms). Omit to disable
   *  staleness (intents without `issuedAt` are never stale). */
  maxIntentAgeMs?: number;
}

/**
 * Route one intent. Pure except for recording a routed intent's id in `dedupe`
 * (the intended, observable side effect that makes routing idempotent).
 */
export function routeIntent(
  intent: OsIntent,
  context: RoutingContext,
  dedupe: IntentDedupeStore,
): IntentOutcome {
  const { intentId } = intent;
  const intentType = intent.type;
  const target = INTENT_TARGET[intentType];

  if (context.maxIntentAgeMs !== undefined && intent.issuedAt !== undefined) {
    const ageMs = context.now - intent.issuedAt;
    // Only positive age is stale; a future `issuedAt` (clock skew) is not.
    if (ageMs > context.maxIntentAgeMs) {
      return { status: "stale", intentId, ageMs, maxAgeMs: context.maxIntentAgeMs };
    }
  }

  const firstAppliedAt = dedupe.firstAppliedAt(intentId, context.now);
  if (firstAppliedAt !== null) {
    return { status: "duplicate", intentId, firstAppliedAt };
  }

  const degrade = evaluateDegrade(intentType, context);
  if (degrade) {
    return { status: "degraded", intentId, intentType, reason: degrade };
  }

  const { reason, missing } = evaluatePrerequisites(intentType, context);
  if (reason) {
    return { status: "blocked", intentId, intentType, reason, missing };
  }

  if (AUTO_START_INTENT_TYPES.has(intentType) && !hasAutoStartConsent(intentType, context)) {
    return { status: "consent-required", intentId, intentType, target };
  }

  const commands = commandsForIntent(intent);
  dedupe.record(intentId, context.now);
  return { status: "routed", intentId, intentType, target, commands };
}

/**
 * A device-capability failure the shell must surface as an unavailable state.
 * Only intents that actually need capture (their prerequisites include
 * `voice-capture`) can degrade; chat intents and the always-allowed `stop-*`
 * never do.
 */
function evaluateDegrade(
  intentType: OsIntentType,
  context: RoutingContext,
): IntentDegradeReason | null {
  if (!INTENT_PREREQUISITES[intentType].includes("voice-capture")) return null;
  if (context.capabilities.sandboxed) return "sandboxed";
  if (!context.capabilities.voiceCapture) return "voice-unsupported";
  return null;
}

/**
 * Check the intent's declared prerequisites against the context. Returns the
 * first blocking reason (in prerequisite-declaration order, so the priority is
 * stable: auth → lock → foreground → mic) plus the full set of unmet
 * prerequisites. `voice-capture` is handled by {@link evaluateDegrade}, not here.
 */
function evaluatePrerequisites(
  intentType: OsIntentType,
  context: RoutingContext,
): { reason: IntentBlockReason | null; missing: IntentPrerequisite[] } {
  const missing: IntentPrerequisite[] = [];
  let reason: IntentBlockReason | null = null;

  for (const prerequisite of INTENT_PREREQUISITES[intentType]) {
    switch (prerequisite) {
      case "session":
        if (context.auth !== "authenticated") {
          missing.push(prerequisite);
          reason ??= context.auth === "expired" ? "auth-expired" : "unauthenticated";
        }
        break;
      case "unlocked":
        if (context.device.locked) {
          missing.push(prerequisite);
          reason ??= "locked";
        }
        break;
      case "foreground":
        if (!context.device.foreground) {
          missing.push(prerequisite);
          reason ??= "backgrounded";
        }
        break;
      case "microphone":
        if (context.capabilities.microphone === "denied") {
          missing.push(prerequisite);
          reason ??= "microphone-denied";
        }
        break;
      case "voice-capture":
        break;
      default: {
        const _exhaustive: never = prerequisite;
        return _exhaustive;
      }
    }
  }

  return { reason, missing };
}

function hasAutoStartConsent(
  intentType: OsIntentType,
  context: RoutingContext,
): boolean {
  if (intentType === "start-voice") return context.consent.autoStartVoice;
  if (intentType === "start-transcription") return context.consent.autoStartTranscription;
  return true;
}

/**
 * The commands a routed intent runs against the one controller. Send/start
 * intents `open` the surface first so the launch is visible; `stop-*` intents
 * emit only the teardown so they stay valid even when nothing is open.
 */
function commandsForIntent(intent: OsIntent): IntentControllerCommand[] {
  switch (intent.type) {
    case "open-chat":
      return [{ kind: "open" }];
    case "send":
      return [
        { kind: "open" },
        {
          kind: "send",
          text: intent.text,
          ...(intent.channelType ? { channelType: intent.channelType } : {}),
          ...(intent.images ? { images: intent.images } : {}),
          ...(intent.metadata ? { metadata: intent.metadata } : {}),
        },
      ];
    case "start-voice":
      return [{ kind: "open" }, { kind: "startRecording", intent: intent.mode }];
    case "stop-voice":
      return [{ kind: "stopRecording" }];
    case "start-transcription":
      return [{ kind: "open" }, { kind: "toggleTranscriptionMode" }];
    case "stop-transcription":
      return [{ kind: "stopTranscriptionAndMic" }];
    case "continue-conversation":
      return [{ kind: "open" }];
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

/** The target surface for an intent type (re-exported for callers rendering the
 *  outcome without importing the constant table directly). */
export function intentTarget(intentType: OsIntentType): IntentTarget {
  return INTENT_TARGET[intentType];
}

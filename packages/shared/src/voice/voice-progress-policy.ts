import { projectVoiceOutput } from "./voice-output-envelope";

export type VoiceProgressImportance = "low" | "normal" | "high";

export interface VoiceProgressOwner {
  responseId: string;
  taskId: string;
  /** Monotonic coordinator generation; increment whenever this owner is rebuilt. */
  ownerEpoch: number;
}

export interface VoiceProgressPolicyConfig {
  /** Earliest elapsed time at which progress may be spoken. */
  spokenThresholdMs?: number;
  /** Minimum time between spoken progress updates. */
  minSpokenIntervalMs?: number;
  /** Hard per-task cap. */
  maxSpokenUpdates?: number;
  /** Quiet window after user speech ends. */
  postUserSpeechSuppressionMs?: number;
  minSpokenImportance?: VoiceProgressImportance;
  /** Progress is deliberately much shorter than a final answer. */
  maxSpeechChars?: number;
}

export interface VoiceProgressState extends VoiceProgressOwner {
  startedAtMs: number;
  lastEventAtMs: number;
  userSpeechActive: boolean;
  userSpeechSequence: number;
  lastUserSpeechEndedAtMs: number | null;
  lastSpokenAtMs: number | null;
  spokenUpdates: number;
  speechCounter: number;
  activeSpeechId: string | null;
  terminal: boolean;
}

export interface VoiceProgressUpdate extends VoiceProgressOwner {
  type: "progress";
  atMs: number;
  phase: string;
  /** Exact visual status. It is never derived from or rewritten for speech. */
  displayMarkdown: string;
  /** Optional short, truthful sentence specifically describing current work. */
  spokenCandidate?: string;
  /** Trusted semantic classification from the progress-producing task. */
  isSpecific?: boolean;
  /** Trusted importance classification from the progress-producing task. */
  importance?: VoiceProgressImportance;
}

export type VoiceProgressEvent =
  | VoiceProgressUpdate
  | (VoiceProgressOwner & {
      type: "user_speech";
      atMs: number;
      active: boolean;
      /** Monotonic local detector segment sequence. */
      sequence: number;
    })
  | (VoiceProgressOwner & { type: "final"; atMs: number })
  | (VoiceProgressOwner & { type: "cancel"; atMs: number })
  | (VoiceProgressOwner & {
      type: "progress_speech_settled";
      atMs: number;
      speechId: string;
    });

export type VoiceProgressSpeechDecision =
  | "spoken"
  | "below_threshold"
  | "not_specific"
  | "low_importance"
  | "user_speech"
  | "cooldown"
  | "speech_active"
  | "limit_reached"
  | "unsafe_or_empty"
  | "terminal"
  | "stale_event"
  | "wrong_owner"
  | "stale_speech"
  | "stale_speech_segment"
  | "state_updated";

export interface VoiceProgressProjection {
  phase: string;
  displayMarkdown: string;
  speechText: string | null;
  captions: string | null;
  speechDecision: VoiceProgressSpeechDecision;
}

export type VoiceProgressEffect =
  | (VoiceProgressOwner & {
      type: "progress_speech/start";
      speechId: string;
      speechText: string;
    })
  | (VoiceProgressOwner & {
      type: "progress_speech/cancel";
      speechId: string;
      reason: "user_speech" | "final" | "cancel";
    });

export interface VoiceProgressTransition {
  state: VoiceProgressState;
  /** Present for every accepted progress event, even when speech is suppressed. */
  projection: VoiceProgressProjection | null;
  effects: readonly VoiceProgressEffect[];
  decision: VoiceProgressSpeechDecision;
}

const DEFAULT_CONFIG = {
  spokenThresholdMs: 900,
  minSpokenIntervalMs: 8_000,
  maxSpokenUpdates: 2,
  postUserSpeechSuppressionMs: 500,
  minSpokenImportance: "normal" as VoiceProgressImportance,
  maxSpeechChars: 160,
};

const IMPORTANCE_RANK: Record<VoiceProgressImportance, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

function finiteNonNegative(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function normalizedConfig(config: VoiceProgressPolicyConfig) {
  return {
    spokenThresholdMs: finiteNonNegative(
      config.spokenThresholdMs,
      DEFAULT_CONFIG.spokenThresholdMs,
    ),
    minSpokenIntervalMs: finiteNonNegative(
      config.minSpokenIntervalMs,
      DEFAULT_CONFIG.minSpokenIntervalMs,
    ),
    maxSpokenUpdates: Math.floor(
      finiteNonNegative(
        config.maxSpokenUpdates,
        DEFAULT_CONFIG.maxSpokenUpdates,
      ),
    ),
    postUserSpeechSuppressionMs: finiteNonNegative(
      config.postUserSpeechSuppressionMs,
      DEFAULT_CONFIG.postUserSpeechSuppressionMs,
    ),
    minSpokenImportance:
      config.minSpokenImportance ?? DEFAULT_CONFIG.minSpokenImportance,
    maxSpeechChars: finiteNonNegative(
      config.maxSpeechChars,
      DEFAULT_CONFIG.maxSpeechChars,
    ),
  };
}

function acceptedProgress(
  state: VoiceProgressState,
  event: VoiceProgressUpdate,
  decision: VoiceProgressSpeechDecision,
  speechText: string | null = null,
): VoiceProgressTransition {
  return {
    state: { ...state, lastEventAtMs: event.atMs },
    projection: {
      phase: event.phase,
      displayMarkdown: event.displayMarkdown,
      speechText,
      captions: speechText,
      speechDecision: decision,
    },
    effects: [],
    decision,
  };
}

function ownerMatches(
  state: VoiceProgressState,
  event: VoiceProgressOwner,
): boolean {
  return (
    state.responseId === event.responseId &&
    state.taskId === event.taskId &&
    state.ownerEpoch === event.ownerEpoch
  );
}

function cancelActiveSpeech(
  state: VoiceProgressState,
  reason: "user_speech" | "final" | "cancel",
): readonly VoiceProgressEffect[] {
  return state.activeSpeechId
    ? [
        {
          type: "progress_speech/cancel",
          responseId: state.responseId,
          taskId: state.taskId,
          ownerEpoch: state.ownerEpoch,
          speechId: state.activeSpeechId,
          reason,
        },
      ]
    : [];
}

export function createVoiceProgressState(
  input: VoiceProgressOwner & { atMs: number },
): VoiceProgressState {
  if (!Number.isFinite(input.atMs)) {
    throw new TypeError("atMs must be finite");
  }
  if (
    !input.responseId ||
    !input.taskId ||
    !Number.isSafeInteger(input.ownerEpoch) ||
    input.ownerEpoch < 0
  ) {
    throw new TypeError(
      "responseId, taskId, and a nonnegative ownerEpoch are required",
    );
  }
  return {
    responseId: input.responseId,
    taskId: input.taskId,
    ownerEpoch: input.ownerEpoch,
    startedAtMs: input.atMs,
    lastEventAtMs: input.atMs,
    userSpeechActive: false,
    userSpeechSequence: -1,
    lastUserSpeechEndedAtMs: null,
    lastSpokenAtMs: null,
    spokenUpdates: 0,
    speechCounter: 0,
    activeSpeechId: null,
    terminal: false,
  };
}

/**
 * Deterministic reducer for one exact response/task owner. Timestamps order
 * events only within that owner; identity mismatch always wins over wall time.
 */
export function reduceVoiceProgress(
  state: VoiceProgressState,
  event: VoiceProgressEvent,
  config: VoiceProgressPolicyConfig = {},
): VoiceProgressTransition {
  if (!ownerMatches(state, event)) {
    return {
      state,
      projection: null,
      effects: [],
      decision: "wrong_owner",
    };
  }

  if (event.type === "final" || event.type === "cancel") {
    if (state.terminal) {
      return { state, projection: null, effects: [], decision: "terminal" };
    }
    return {
      state: {
        ...state,
        lastEventAtMs: Number.isFinite(event.atMs)
          ? Math.max(state.lastEventAtMs, event.atMs)
          : state.lastEventAtMs,
        activeSpeechId: null,
        terminal: true,
      },
      projection: null,
      effects: cancelActiveSpeech(state, event.type),
      decision: "terminal",
    };
  }

  if (event.type === "user_speech") {
    const validSequence =
      Number.isSafeInteger(event.sequence) && event.sequence >= 0;
    const reopensSettledSegment =
      event.sequence === state.userSpeechSequence &&
      event.active &&
      !state.userSpeechActive;
    if (
      !validSequence ||
      event.sequence < state.userSpeechSequence ||
      reopensSettledSegment
    ) {
      return {
        state,
        projection: null,
        effects: [],
        decision: "stale_speech_segment",
      };
    }
    if (state.terminal) {
      return { state, projection: null, effects: [], decision: "terminal" };
    }
    const wasActive = state.userSpeechActive;
    const orderedAtMs = Number.isFinite(event.atMs)
      ? Math.max(state.lastEventAtMs, event.atMs)
      : state.lastEventAtMs;
    return {
      state: {
        ...state,
        lastEventAtMs: orderedAtMs,
        userSpeechActive: event.active,
        userSpeechSequence: event.sequence,
        lastUserSpeechEndedAtMs: event.active
          ? state.lastUserSpeechEndedAtMs
          : orderedAtMs,
        activeSpeechId: event.active ? null : state.activeSpeechId,
      },
      projection: null,
      effects:
        event.active && !wasActive
          ? cancelActiveSpeech(state, "user_speech")
          : [],
      decision: event.active ? "user_speech" : "state_updated",
    };
  }

  if (event.type === "progress_speech_settled") {
    if (state.terminal) {
      return { state, projection: null, effects: [], decision: "terminal" };
    }
    if (state.activeSpeechId !== event.speechId) {
      return {
        state,
        projection: null,
        effects: [],
        decision: "stale_speech",
      };
    }
    return {
      state: {
        ...state,
        lastEventAtMs: Number.isFinite(event.atMs)
          ? Math.max(state.lastEventAtMs, event.atMs)
          : state.lastEventAtMs,
        activeSpeechId: null,
      },
      projection: null,
      effects: [],
      decision: "state_updated",
    };
  }

  if (!Number.isFinite(event.atMs) || event.atMs < state.lastEventAtMs) {
    return {
      state,
      projection: null,
      effects: [],
      decision: "stale_event",
    };
  }
  if (state.terminal) {
    return { state, projection: null, effects: [], decision: "terminal" };
  }

  if (event.type !== "progress") {
    const exhaustive: never = event;
    return exhaustive;
  }

  const policy = normalizedConfig(config);
  if (event.atMs - state.startedAtMs < policy.spokenThresholdMs) {
    return acceptedProgress(state, event, "below_threshold");
  }
  if (!event.isSpecific || !event.spokenCandidate?.trim()) {
    return acceptedProgress(state, event, "not_specific");
  }
  if (
    IMPORTANCE_RANK[event.importance ?? "normal"] <
    IMPORTANCE_RANK[policy.minSpokenImportance]
  ) {
    return acceptedProgress(state, event, "low_importance");
  }
  if (
    state.userSpeechActive ||
    (state.lastUserSpeechEndedAtMs !== null &&
      event.atMs - state.lastUserSpeechEndedAtMs <
        policy.postUserSpeechSuppressionMs)
  ) {
    return acceptedProgress(state, event, "user_speech");
  }
  if (state.activeSpeechId) {
    return acceptedProgress(state, event, "speech_active");
  }
  if (
    state.lastSpokenAtMs !== null &&
    event.atMs - state.lastSpokenAtMs < policy.minSpokenIntervalMs
  ) {
    return acceptedProgress(state, event, "cooldown");
  }
  if (state.spokenUpdates >= policy.maxSpokenUpdates) {
    return acceptedProgress(state, event, "limit_reached");
  }

  const speech = projectVoiceOutput(
    {
      policy: "say",
      display: { markdown: "" },
      spoken: event.spokenCandidate,
    },
    { maxSpeechChars: policy.maxSpeechChars },
  );
  if (!speech.speechText) {
    return acceptedProgress(state, event, "unsafe_or_empty");
  }

  const speechCounter = state.speechCounter + 1;
  const speechId = `voice-progress-v1:${state.responseId.length}:${state.responseId}:${state.taskId.length}:${state.taskId}:${state.ownerEpoch}:${speechCounter}`;
  return {
    state: {
      ...state,
      lastEventAtMs: event.atMs,
      lastSpokenAtMs: event.atMs,
      spokenUpdates: state.spokenUpdates + 1,
      speechCounter,
      activeSpeechId: speechId,
    },
    projection: {
      phase: event.phase,
      displayMarkdown: event.displayMarkdown,
      speechText: speech.speechText,
      captions: speech.speechText,
      speechDecision: "spoken",
    },
    effects: [
      {
        type: "progress_speech/start",
        responseId: state.responseId,
        taskId: state.taskId,
        ownerEpoch: state.ownerEpoch,
        speechId,
        speechText: speech.speechText,
      },
    ],
    decision: "spoken",
  };
}

/**
 * Effect interpreters must check this after installing transition.state and
 * immediately before starting TTS. This tombstones a queued start effect when
 * a later final/cancel/user-speech transition has already revoked it.
 */
export function isVoiceProgressSpeechAuthorized(
  state: VoiceProgressState,
  speechId: string,
): boolean {
  return !state.terminal && state.activeSpeechId === speechId;
}

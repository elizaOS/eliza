/**
 * The serialisable projection of the shell chat/voice engine that the owner
 * window broadcasts to its followers (#16442). A follower renders this snapshot
 * instead of running its own `useShellController`, so every window shows one
 * coherent conversation + voice state.
 *
 * It mirrors the READ surface of `ShellController` minus anything that cannot
 * cross a window boundary: the live `AnalyserNode` (a follower shows no waveform
 * animation — honest, since it owns no capture) and the imperative methods
 * (those become typed commands). Producing it is a pure map from the controller,
 * which keeps `snapshotsEqual` cheap enough to coalesce the many per-token
 * updates a streaming reply emits.
 */
import type { ChatTurnStatus } from "../../../api/client-types-chat";
import type { HomeModelStatus } from "../../../services/local-inference/home-model-status";
import type { MicrophonePermissionState } from "../../../voice/local-asr-capture";
import type { ShellAuthGate } from "../shell-auth-gate";
import {
  isShellPhase,
  type ShellMessage,
  type ShellPhase,
} from "../shell-state";
import type { ShellController } from "../useShellController";

/** The subset of {@link import("../conversation-nav").ConversationNav} that is
 *  data (the imperative `goPrev`/`goNext` become nav commands). */
export interface ShellConversationNavSnapshot {
  hasPrev: boolean;
  hasNext: boolean;
  activeId: string | null;
  index: number;
}

export interface ShellControllerSnapshot {
  phase: ShellPhase;
  authGate: ShellAuthGate;
  signingIn: boolean;
  responding: boolean;
  turnStatus: ChatTurnStatus | null;
  messages: readonly ShellMessage[];
  canSend: boolean;
  modelStatus: HomeModelStatus;
  recording: boolean;
  waveformMode: "idle" | "listening" | "responding";
  isOpen: boolean;
  visionCapturing: boolean;
  transcript: string;
  speaking: boolean;
  agentVoiceMuted: boolean;
  needsAudioUnlock: boolean;
  handsFree: boolean;
  micPermission: MicrophonePermissionState;
  transcriptionMode: boolean;
  currentTab?: string;
  conversationLoading?: boolean;
  noProviderConfigured?: boolean;
  bootProgressSignal?: string;
  conversationNav: ShellConversationNavSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly decode a snapshot received from the native authority. */
export function parseShellControllerSnapshot(
  value: unknown,
): ShellControllerSnapshot | null {
  if (!isRecord(value)) return null;
  const phase = value.phase;
  const waveformMode = value.waveformMode;
  const micPermission = value.micPermission;
  const nav = value.conversationNav;
  const model = value.modelStatus;
  const messages = value.messages;
  const authGate = value.authGate;
  if (
    !isShellPhase(phase) ||
    !isRecord(authGate) ||
    typeof authGate.gated !== "boolean" ||
    !(
      authGate.phase === "checking" ||
      authGate.phase === "unavailable" ||
      authGate.phase === "needs-auth" ||
      authGate.phase === "clear"
    ) ||
    authGate.gated !== (authGate.phase !== "clear") ||
    typeof value.signingIn !== "boolean" ||
    typeof value.responding !== "boolean" ||
    (value.turnStatus !== null && !isRecord(value.turnStatus)) ||
    !Array.isArray(messages) ||
    messages.length > 10_000 ||
    !messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === "string" &&
        message.id.length > 0 &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        typeof message.createdAt === "number" &&
        Number.isFinite(message.createdAt),
    ) ||
    typeof value.canSend !== "boolean" ||
    !isRecord(model) ||
    typeof model.kind !== "string" ||
    typeof model.blocksSend !== "boolean" ||
    typeof value.recording !== "boolean" ||
    !(
      waveformMode === "idle" ||
      waveformMode === "listening" ||
      waveformMode === "responding"
    ) ||
    typeof value.isOpen !== "boolean" ||
    typeof value.visionCapturing !== "boolean" ||
    typeof value.transcript !== "string" ||
    typeof value.speaking !== "boolean" ||
    typeof value.agentVoiceMuted !== "boolean" ||
    typeof value.needsAudioUnlock !== "boolean" ||
    typeof value.handsFree !== "boolean" ||
    !(
      micPermission === "granted" ||
      micPermission === "denied" ||
      micPermission === "prompt" ||
      micPermission === "unknown"
    ) ||
    typeof value.transcriptionMode !== "boolean" ||
    !isRecord(nav) ||
    typeof nav.hasPrev !== "boolean" ||
    typeof nav.hasNext !== "boolean" ||
    !(nav.activeId === null || typeof nav.activeId === "string") ||
    !Number.isInteger(nav.index)
  ) {
    return null;
  }
  return value as unknown as ShellControllerSnapshot;
}

/** Project the live controller into its wire snapshot. Pure. */
export function deriveShellControllerSnapshot(
  controller: ShellController,
): ShellControllerSnapshot {
  return {
    phase: controller.phase,
    authGate: controller.authGate,
    signingIn: controller.signingIn,
    responding: controller.responding,
    turnStatus: controller.turnStatus,
    messages: controller.messages,
    canSend: controller.canSend,
    modelStatus: controller.modelStatus,
    recording: controller.recording,
    waveformMode: controller.waveformMode,
    isOpen: controller.isOpen,
    visionCapturing: controller.visionCapturing,
    transcript: controller.transcript,
    speaking: controller.speaking,
    agentVoiceMuted: controller.agentVoiceMuted,
    needsAudioUnlock: controller.needsAudioUnlock,
    handsFree: controller.handsFree,
    micPermission: controller.micPermission,
    transcriptionMode: controller.transcriptionMode,
    currentTab: controller.currentTab,
    conversationLoading: controller.conversationLoading,
    noProviderConfigured: controller.noProviderConfigured,
    bootProgressSignal: controller.bootProgressSignal,
    conversationNav: {
      hasPrev: controller.conversationNav.hasPrev,
      hasNext: controller.conversationNav.hasNext,
      activeId: controller.conversationNav.activeId,
      index: controller.conversationNav.index,
    },
  };
}

function navEqual(
  a: ShellConversationNavSnapshot,
  b: ShellConversationNavSnapshot,
): boolean {
  return (
    a.hasPrev === b.hasPrev &&
    a.hasNext === b.hasNext &&
    a.activeId === b.activeId &&
    a.index === b.index
  );
}

// Compared structurally rather than by reference so coalescing does not depend
// on the identity discipline of the model-status hook: it changes only on real
// readiness transitions, but the wire-relayed snapshot is deserialised into a
// fresh object on followers, and a re-publish must not hinge on that.
function modelStatusEqual(a: HomeModelStatus, b: HomeModelStatus): boolean {
  return (
    a.kind === b.kind &&
    a.blocksSend === b.blocksSend &&
    a.percent === b.percent &&
    a.etaMs === b.etaMs &&
    a.modelName === b.modelName &&
    a.modelId === b.modelId &&
    a.errors === b.errors
  );
}

/**
 * Shallow structural equality used to coalesce publishes: a streamed reply
 * hands `messages` a new array reference per token, but the projection reuses
 * per-message identity, so a reference compare on the array plus scalar compares
 * on the rest is exact. Returns true only when nothing a follower would render
 * changed, so an unchanged tick does not cost an IPC round-trip.
 */
export function snapshotsEqual(
  a: ShellControllerSnapshot,
  b: ShellControllerSnapshot,
): boolean {
  return (
    a.phase === b.phase &&
    a.authGate.gated === b.authGate.gated &&
    a.authGate.phase === b.authGate.phase &&
    a.signingIn === b.signingIn &&
    a.responding === b.responding &&
    a.turnStatus === b.turnStatus &&
    a.messages === b.messages &&
    a.canSend === b.canSend &&
    modelStatusEqual(a.modelStatus, b.modelStatus) &&
    a.recording === b.recording &&
    a.waveformMode === b.waveformMode &&
    a.isOpen === b.isOpen &&
    a.visionCapturing === b.visionCapturing &&
    a.transcript === b.transcript &&
    a.speaking === b.speaking &&
    a.agentVoiceMuted === b.agentVoiceMuted &&
    a.needsAudioUnlock === b.needsAudioUnlock &&
    a.handsFree === b.handsFree &&
    a.micPermission === b.micPermission &&
    a.transcriptionMode === b.transcriptionMode &&
    a.currentTab === b.currentTab &&
    a.conversationLoading === b.conversationLoading &&
    a.noProviderConfigured === b.noProviderConfigured &&
    a.bootProgressSignal === b.bootProgressSignal &&
    navEqual(a.conversationNav, b.conversationNav)
  );
}

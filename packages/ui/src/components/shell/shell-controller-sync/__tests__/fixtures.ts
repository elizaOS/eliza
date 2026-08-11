/** Shared test fixtures for the shell-controller-sync suite: a full snapshot and
 *  a fully-stubbed `ShellController` whose methods are spies. */
import { vi } from "vitest";
import type { HomeModelStatus } from "../../../../services/local-inference/home-model-status";
import type { ShellMessage } from "../../shell-state";
import type { ShellController } from "../../useShellController";
import type { ShellControllerSnapshot } from "../snapshot";

// Shared stable references so two default snapshots coalesce as equal (mirrors
// production, where messages preserve identity and model-status holds a stable
// reference across renders).
const EMPTY_MESSAGES: readonly ShellMessage[] = Object.freeze([]);
const NOT_REQUIRED_MODEL: HomeModelStatus = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

export function baseSnapshot(
  over: Partial<ShellControllerSnapshot> = {},
): ShellControllerSnapshot {
  return {
    phase: "idle",
    responding: false,
    turnStatus: null,
    messages: EMPTY_MESSAGES,
    canSend: true,
    modelStatus: NOT_REQUIRED_MODEL,
    recording: false,
    waveformMode: "idle",
    isOpen: false,
    visionCapturing: false,
    transcript: "",
    speaking: false,
    agentVoiceMuted: false,
    needsAudioUnlock: false,
    handsFree: false,
    micPermission: "granted",
    transcriptionMode: false,
    conversationNav: {
      hasPrev: false,
      hasNext: false,
      activeId: null,
      index: -1,
    },
    ...over,
  };
}

export function makeFakeShellController(): ShellController {
  return {
    phase: "idle",
    responding: false,
    turnStatus: null,
    messages: [],
    canSend: true,
    modelStatus: {
      kind: "not-required",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    },
    recording: false,
    waveformMode: "idle",
    analyser: null,
    isOpen: false,
    visionCapturing: false,
    handsFree: false,
    micPermission: "granted",
    transcriptionMode: false,
    transcript: "",
    speaking: false,
    agentVoiceMuted: false,
    needsAudioUnlock: false,
    open: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    captureVision: vi.fn(),
    toggleRecording: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleHandsFree: vi.fn(),
    recheckMicPermission: vi.fn(async () => "granted" as const),
    toggleTranscriptionMode: vi.fn(),
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    toggleAgentVoiceMute: vi.fn(),
    unlockAudio: vi.fn(),
    clearConversation: vi.fn(),
    openSettings: vi.fn(),
    navigateHome: vi.fn(),
    stop: vi.fn(),
    conversationNav: {
      hasPrev: false,
      hasNext: false,
      activeId: null,
      index: -1,
      goPrev: vi.fn(),
      goNext: vi.fn(),
    },
  };
}

// spec/os/voice/cloudSpeech.md, "Story: Talk to the agent through the cloud speech relay"; spec/os/voice/cloudSpeech.md, "A provider speech edge belongs to the capture live when it began, and a retired capture owns none"; spec/os/voice/cloudSpeech.md, "A reply settles once: completed when all its audio has played, or cancelled"; spec/os/voice/cloudSpeech.md, "An open session and every waiting batch request run under the current key, and a key change ends them"
import type { PluginListenerHandle } from "@capacitor/core";
import type { Brand } from "effect";
import type { CredentialId, EnvironmentName } from "./sign-in.ts";

export type { CredentialId, EnvironmentName };

export type SpeechSessionId = string & Brand.Brand<"SpeechSessionId">;
export type UtteranceId = string & Brand.Brand<"UtteranceId">;
export type NativeSpeechRequestId = string & Brand.Brand<"NativeSpeechRequestId">;

export type CloudSpeechListenerHandle = PluginListenerHandle;

export type CloudStreamEventType = "speech-start" | "speech-end" | "transcript" | "level" | "audio-start" | "audio-end" | "error";

export interface CloudStreamEvent {
  readonly sessionId?: unknown;
  readonly type?: unknown;
  readonly text?: unknown;
  readonly final?: unknown;
  readonly peak?: unknown;
  readonly utteranceId?: unknown;
  readonly code?: unknown;
  readonly data?: unknown;
  readonly interrupted?: unknown;
}

export interface CloudSpeechStarted {
  readonly sessionId: SpeechSessionId;
  readonly sampleRate: number;
  readonly echoCancelled: boolean;
}

export interface CloudStreamPort {
  startCloudSpeech(input: { sessionId: SpeechSessionId; environment: EnvironmentName; credentialId: CredentialId; muted?: boolean }): Promise<CloudSpeechStarted>;
  stopCloudSpeech(input: { sessionId: SpeechSessionId }): Promise<unknown>;
  setCloudSpeechOutputMuted?(input: { sessionId: SpeechSessionId; muted: boolean }): Promise<unknown>;
  setCloudSpeechMuted(input: { sessionId: SpeechSessionId; muted: boolean }): Promise<unknown>;
  speakCloudSpeech(input: { sessionId: SpeechSessionId; utteranceId: UtteranceId; text: string }): Promise<unknown>;
  cancelCloudSpeech(input: { sessionId: SpeechSessionId; utteranceId: UtteranceId }): Promise<unknown>;
  addListener(event: "cloudSpeechEvent", callback: (event: CloudStreamEvent) => void): Promise<CloudSpeechListenerHandle>;
}

export type ElizaCloudSpeechPlugin = CloudStreamPort;

export interface AssistantListenHandlers {
  readonly signal: AbortSignal;
  onSpeechStart(atMs: number): void;
  onSpeechEnd(atMs: number): void;
  onSegment(text: string | null): void;
  onLevel?(peak: number): void;
  onEnd(error?: unknown): void;
}

export interface AssistantCapture {
  readonly fullDuplex: boolean;
  close(): Promise<void>;
  cancel(): Promise<void>;
}

export interface CloudStreamingSpeechOptions {
  readonly environment: EnvironmentName;
  readonly credentialId: CredentialId;
  assertCurrent(): void;
  onInterim?(text: string): void;
}

export interface CloudStreamingSpeech {
  setOutputMuted(muted: boolean): Promise<void>;
  listen(handlers: AssistantListenHandlers): Promise<AssistantCapture>;
  speak(text: string, signal: AbortSignal, onStarted: () => void): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeSpeechRequestBinding {
  check(): void;
  watch(onChange: () => void): () => void;
  cancel(requestId: NativeSpeechRequestId): Promise<unknown> | undefined;
  readonly cancelledMessage?: string;
  newRequestId?(): NativeSpeechRequestId;
}

export type NativeSpeechRequestWork<T> = (requestId: NativeSpeechRequestId, interrupted: Promise<never>, owned: AbortSignal) => Promise<T>;

export type NativeSpeechRequestRunner = <T>(signal: AbortSignal, work: NativeSpeechRequestWork<T>) => Promise<T>;

export function throwStale(stale: { readonly error: unknown } | undefined): void {
  if (stale) throw stale.error;
}

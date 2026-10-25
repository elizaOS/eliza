/**
 * Opt-in provenance for one buffered speech task, from transport to source retirement.
 * Observers receive complete independent byte/channel copies only when enabled.
 * Credentials are never accepted here; buffered transport resolution is not a
 * first-byte measurement, and an audio-clock deadline is not a native end event.
 */
import { reportRendererDiagnostic } from "../utils/renderer-diagnostics";
import type { SpeakTask, SpeechProviderKind } from "./voice-chat-types";

export type VoiceTransportLeg =
  | "elevenlabs-direct"
  | "elevenlabs-proxy"
  | "cloud-direct"
  | "cloud-proxy"
  | "local-inference";

export type VoicePlaybackTerminal =
  | "source-ended"
  | "audio-clock-deadline"
  | "cancelled"
  | "failed";

type EvidencePayload =
  | {
      kind: "queued";
      generation: number;
      text: string;
      segment: SpeakTask["segment"];
      provider: SpeechProviderKind;
      telemetry: SpeakTask["telemetry"];
    }
  | { kind: "request"; requestId: number; leg: VoiceTransportLeg; body: string }
  | {
      kind: "response";
      requestId: number;
      status: number;
      contentType: string | null;
    }
  | { kind: "request-failed"; requestId: number }
  | {
      kind: "encoded";
      requestId: number | null;
      origin: "response" | "cache-unattributed";
      bytes: Uint8Array;
    }
  | {
      kind: "decoded";
      bufferId: number;
      sampleRate: number;
      channels: Float32Array[];
    }
  | { kind: "source-started"; bufferId: number; audioTime: number }
  | {
      kind: "terminal";
      outcome: VoicePlaybackTerminal;
      audioTime: number | null;
    };

export type VoicePlaybackEvidenceEvent = EvidencePayload & {
  taskId: string;
  atMs: number;
};

/** Synchronous diagnostic sink; retaining the supplied full values is opt-in. */
export type VoicePlaybackObserver = (event: VoicePlaybackEvidenceEvent) => void;

export class BufferedVoiceEvidence {
  private readonly taskId = crypto.randomUUID();
  private readonly responses = new WeakMap<Response, number>();
  private requestSequence = 0;
  private bufferSequence = 0;
  private retired = false;

  constructor(
    private readonly observer: VoicePlaybackObserver,
    private readonly onRetired: () => void,
  ) {}

  emit(payload: EvidencePayload): void {
    if (this.retired) return;
    try {
      this.observer({
        ...payload,
        taskId: this.taskId,
        atMs: performance.now(),
      });
    } catch (error) {
      // error-policy:J7 Evidence collection cannot change playback or recursively notify its observer.
      reportRendererDiagnostic({ scope: "voice.playback-observer", error });
    }
  }

  async request(
    leg: VoiceTransportLeg,
    body: string,
    dispatch: () => Promise<Response>,
  ): Promise<Response> {
    const requestId = ++this.requestSequence;
    this.emit({ kind: "request", requestId, leg, body });
    try {
      if (this.retired)
        throw new DOMException("Speech cancelled", "AbortError");
      const response = await dispatch();
      this.responses.set(response, requestId);
      this.emit({
        kind: "response",
        requestId,
        status: response.status,
        contentType: response.headers.get("content-type"),
      });
      return response;
    } catch (error) {
      // error-policy:J2 Preserve the original transport failure and the caller's fallback policy.
      this.emit({ kind: "request-failed", requestId });
      throw error;
    }
  }

  encoded(bytes: Uint8Array, response: Response | null): void {
    if (this.retired) return;
    this.emit({
      kind: "encoded",
      bytes: bytes.slice(),
      requestId: response ? (this.responses.get(response) ?? null) : null,
      origin: response ? "response" : "cache-unattributed",
    });
  }

  decoded(buffer: AudioBuffer): number {
    const bufferId = ++this.bufferSequence;
    if (!this.retired) {
      const channels = Array.from(
        { length: buffer.numberOfChannels },
        (_, index) => buffer.getChannelData(index).slice(),
      );
      this.emit({
        kind: "decoded",
        bufferId,
        sampleRate: buffer.sampleRate,
        channels,
      });
    }
    return bufferId;
  }

  terminal(
    outcome: VoicePlaybackTerminal,
    audioTime: number | null = null,
  ): void {
    if (this.retired) return;
    // Retire before observer invocation so reentrant cancellation cannot emit twice.
    this.retired = true;
    this.onRetired();
    try {
      this.observer({
        kind: "terminal",
        taskId: this.taskId,
        atMs: performance.now(),
        outcome,
        audioTime,
      });
    } catch (error) {
      // error-policy:J7 Terminal diagnostics cannot alter the completed playback outcome.
      reportRendererDiagnostic({ scope: "voice.playback-observer", error });
    }
  }
}

/** Leaves the ordinary dispatch path synchronous when observation is disabled. */
export function observeVoiceRequest(
  evidence: BufferedVoiceEvidence | undefined,
  leg: VoiceTransportLeg,
  body: string,
  dispatch: () => Promise<Response>,
): Promise<Response> {
  return evidence ? evidence.request(leg, body, dispatch) : dispatch();
}

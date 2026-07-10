/**
 * Test fakes for the realtime voice-session client suite.
 *
 * These are TRANSPORTS/HOST doubles only (fake WebSocket, fake AudioContext,
 * fake getUserMedia). They drive the REAL client framing / state machine /
 * barge-in / reconnect / PCM code — never a stub of the thing under test.
 */

import type {
  MicAudioContextLike,
  AudioNodeLike,
  ScriptProcessorNodeLike,
} from "../voice-session-mic-capture";
import type {
  PlaybackAudioContextLike,
  PlaybackNodeLike,
  PlaybackScriptNodeLike,
} from "../voice-session-playback";
import type { VoiceWebSocketLike } from "../voice-session-client";

// ── Fake WebSocket ─────────────────────────────────────────────────────

type Listeners = {
  open: Array<() => void>;
  message: Array<(e: { data: unknown }) => void>;
  close: Array<(e: { code?: number; reason?: string }) => void>;
  error: Array<() => void>;
};

export class FakeWebSocket implements VoiceWebSocketLike {
  binaryType = "blob";
  readonly url: string;
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners: Listeners = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (e: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: keyof Listeners, listener: (...args: never[]) => void): void {
    (this.listeners[type] as Array<(...a: never[]) => void>).push(listener);
  }

  // ── test drivers ──
  emitOpen(): void {
    for (const l of this.listeners.open) l();
  }
  emitControl(frame: Record<string, unknown>): void {
    const json = JSON.stringify(frame);
    for (const l of this.listeners.message) l({ data: json });
  }
  emitRaw(data: unknown): void {
    for (const l of this.listeners.message) l({ data });
  }
  emitAudio(bytes: Uint8Array): void {
    const ab = bytes.slice().buffer;
    for (const l of this.listeners.message) l({ data: ab });
  }
  emitClose(code = 1006, reason = "abnormal"): void {
    this.closed = this.closed ?? { code, reason };
    for (const l of this.listeners.close) l({ code, reason });
  }
  emitError(): void {
    for (const l of this.listeners.error) l();
  }

  /** Parse the JSON control frames this socket has sent, in order. */
  sentControls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  /** Count of binary uplink frames sent. */
  sentAudioCount(): number {
    return this.sent.filter((d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d)).length;
  }
}

/** A WS factory that records each socket it creates so a test can drive it. */
export function makeWsFactory(): {
  factory: (url: string) => FakeWebSocket;
  sockets: FakeWebSocket[];
  last(): FakeWebSocket;
} {
  const sockets: FakeWebSocket[] = [];
  return {
    factory: (url: string) => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s;
    },
    sockets,
    last: () => sockets[sockets.length - 1],
  };
}

// ── Fake node ──

class FakeNode implements AudioNodeLike, PlaybackNodeLike {
  connect(target: AudioNodeLike & PlaybackNodeLike): AudioNodeLike & PlaybackNodeLike {
    return target;
  }
  disconnect(): void {}
}

// ── Fake mic AudioContext (ScriptProcessor path — WebView 113) ─────────

export class FakeMicAudioContext implements MicAudioContextLike {
  state: "suspended" | "running" | "closed" = "suspended";
  readonly destination = new FakeNode();
  scriptNode: FakeScriptProcessor | null = null;
  closed = false;
  // no audioWorklet property → forces the ScriptProcessor fallback path.
  constructor(readonly sampleRate = 16_000) {}

  createMediaStreamSource(): AudioNodeLike {
    return new FakeNode();
  }
  createScriptProcessor(): ScriptProcessorNodeLike {
    this.scriptNode = new FakeScriptProcessor();
    return this.scriptNode;
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
  async suspend(): Promise<void> {
    this.state = "suspended";
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
}

class FakeScriptProcessor extends FakeNode implements ScriptProcessorNodeLike {
  onaudioprocess:
    | ((event: {
        inputBuffer: { getChannelData(channel: number): Float32Array };
      }) => void)
    | null = null;

  /** Drive one audioprocess block with the given mono Float32 samples. */
  feed(samples: Float32Array): void {
    this.onaudioprocess?.({
      inputBuffer: { getChannelData: () => samples },
    });
  }
}

// ── Fake playback AudioContext (ScriptProcessor path) ──────────────────

export class FakePlaybackAudioContext implements PlaybackAudioContextLike {
  state: "suspended" | "running" | "closed" = "suspended";
  readonly destination = new FakeNode();
  scriptNode: FakePlaybackScriptNode | null = null;
  closed = false;
  constructor(readonly sampleRate = 16_000) {}

  createScriptProcessor(): PlaybackScriptNodeLike {
    this.scriptNode = new FakePlaybackScriptNode();
    return this.scriptNode;
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
}

export class FakePlaybackScriptNode extends FakeNode implements PlaybackScriptNodeLike {
  onaudioprocess:
    | ((event: {
        outputBuffer: {
          numberOfChannels: number;
          getChannelData(channel: number): Float32Array;
        };
      }) => void)
    | null = null;

  /**
   * Render one block of `length` samples and return the mono output. Simulates
   * the audio engine pulling from the sink's queue.
   */
  render(length: number): Float32Array {
    const buf = new Float32Array(length);
    this.onaudioprocess?.({
      outputBuffer: {
        numberOfChannels: 1,
        getChannelData: () => buf,
      },
    });
    return buf;
  }
}

// ── Fake getUserMedia ──────────────────────────────────────────────────

export function fakeGetUserMedia(): (c: MediaStreamConstraints) => Promise<MediaStream> {
  return async () =>
    ({
      getTracks: () => [{ stop() {} }],
    }) as unknown as MediaStream;
}

export function deniedGetUserMedia(): (c: MediaStreamConstraints) => Promise<MediaStream> {
  return async () => {
    const err = new Error("denied");
    (err as { name?: string }).name = "NotAllowedError";
    throw err;
  };
}

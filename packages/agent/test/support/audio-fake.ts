// spec/agent/voice/clientAudio.md, "The capture keeps a bounded prefix in arrival order while the meter keeps counting"; spec/agent/voice/clientAudio.md, "A WAV holds every sample in order as mono PCM16 behind a 44-byte header"
import { Effect } from "effect"
import type { CaptureAudioPort, CaptureContext, CaptureNode } from "../../src/voice/capture.vibe"
import { browserCaptureAudio } from "../../src/voice/capture-browser.ts"
import type {
  PlayerEvent, ProgressiveSpeechSource, SpeechAudioFrame, SpeechEndFrame, SpeechMedia, SpeechMediaSource, SpeechPlayer, SpeechSourceBuffer,
} from "../../src/voice/playback.vibe"

const renderQuantum = 128

interface SampleProcessor {
  process(inputs: Float32Array[][]): boolean
}

const processors = new Map<string, new () => SampleProcessor>()
let nextPort: MessagePort | undefined

class FakeWorkletNode implements CaptureNode {
  readonly port: MessagePort
  readonly processor: SampleProcessor
  constructor(_context: unknown, name: string) {
    const Processor = processors.get(name)
    if (Processor === undefined) throw new Error(`no processor ${name}`)
    const { port1, port2 } = new MessageChannel()
    nextPort = port1
    this.processor = new Processor()
    nextPort = undefined
    this.port = port2
  }
  connect(): void {}
  disconnect(): void {}
}

Object.assign(globalThis, {
  AudioWorkletProcessor: class {
    readonly port = nextPort
  },
  AudioWorkletNode: FakeWorkletNode,
  registerProcessor: (name: string, processor: new () => SampleProcessor) => processors.set(name, processor),
})

export class FakeMicrophone {
  tracksStopped = 0
  processor: SampleProcessor | undefined
  connected: SampleProcessor | undefined

  getTracks(): Array<{ stop(): void }> {
    return [{ stop: () => (this.tracksStopped += 1) }]
  }

  say(first: Float32Array, second: Float32Array = new Float32Array(first.length)): void {
    for (let start = 0; start < first.length; start += renderQuantum) {
      this.processor?.process([[first.subarray(start, start + renderQuantum), second.subarray(start, start + renderQuantum)]])
    }
  }

  processorAlive(): boolean | undefined {
    return this.connected?.process([[new Float32Array(renderQuantum)]])
  }
}

export class FakeAudioContext implements CaptureContext<FakeMicrophone> {
  readonly destination = {}
  closed = false
  resumed = false
  constructor(readonly sampleRate: number, readonly workletFails = false) {}

  readonly audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      if (this.workletFails) throw new Error("worklet refused")
      await import(url)
    },
  }

  createMediaStreamSource(stream: FakeMicrophone): CaptureNode {
    return {
      connect: (node) => {
        stream.processor = (node as FakeWorkletNode).processor
        stream.connected = stream.processor
      },
      disconnect: () => {
        stream.processor = undefined
      },
    }
  }

  resume(): Promise<void> {
    this.resumed = true
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

export function fakeCaptureAudio(options: { readonly workletFails?: boolean } = {}): CaptureAudioPort<FakeMicrophone, FakeAudioContext> & { readonly opened: FakeAudioContext[] } {
  const opened: FakeAudioContext[] = []
  return {
    opened,
    open: (sampleRate) => {
      const context = new FakeAudioContext(sampleRate, options.workletFails)
      opened.push(context)
      return context
    },
    samples: (context, receive) => browserCaptureAudio.samples(context as unknown as AudioContext, receive),
  }
}

class FakeEvents<Name extends string> {
  readonly listeners = new Map<Name, Set<() => void>>()

  addEventListener(type: Name, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
  }

  removeEventListener(type: Name, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: Name): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

export class FakePlayer extends FakeEvents<PlayerEvent> implements SpeechPlayer {
  src = ""
  playbackRate = 1
  defaultPlaybackRate = 1
  preservesPitch = false
  paused = 0

  async play(): Promise<void> {}

  pause(): void {
    this.paused += 1
  }

  load(): void {}

  removeAttribute(): void {
    this.src = ""
  }
}

export function tone(value: number, samples: number): Float32Array {
  return new Float32Array(samples).fill(value)
}

class FakeSourceBuffer extends FakeEvents<"updateend" | "error"> implements SpeechSourceBuffer {
  readonly appended: number[] = []

  appendBuffer(data: ArrayBuffer): void {
    this.appended.push(data.byteLength)
    Effect.runFork(Effect.andThen(Effect.yieldNow, Effect.sync(() => this.emit("updateend"))))
  }
}

class FakeMediaSource extends FakeEvents<"sourceopen" | "error"> implements SpeechMediaSource {
  readonly buffers: FakeSourceBuffer[] = []
  ended = false

  override addEventListener(type: "sourceopen" | "error", listener: () => void): void {
    super.addEventListener(type, listener)
    if (type === "sourceopen") Effect.runFork(Effect.andThen(Effect.yieldNow, Effect.sync(() => this.emit("sourceopen"))))
  }

  addSourceBuffer(): SpeechSourceBuffer {
    const buffer = new FakeSourceBuffer()
    this.buffers.push(buffer)
    return buffer
  }

  endOfStream(): void {
    this.ended = true
  }
}

export function fakeSpeechMedia(): SpeechMedia & { readonly sources: FakeMediaSource[]; readonly created: string[]; readonly revoked: string[] } {
  const sources: FakeMediaSource[] = []
  const created: string[] = []
  const revoked: string[] = []
  const url = () => {
    created.push(`blob:speech-${created.length + 1}`)
    return created.at(-1) ?? ""
  }
  return {
    sources, created, revoked,
    stream: () => {
      const source = new FakeMediaSource()
      sources.push(source)
      return { source, url: url() }
    },
    clipUrl: url,
    revokeUrl: (revokedUrl) => {
      revoked.push(revokedUrl)
    },
  }
}

export class FakeSpeechSource implements ProgressiveSpeechSource<SpeechAudioFrame> {
  readonly renderedSpeed = null
  cancelled = false
  readonly #frames: SpeechAudioFrame[]
  readonly #end = Promise.withResolvers<SpeechEndFrame>()

  constructor(...frames: Uint8Array[]) {
    this.#frames = frames.map((audio) => ({ type: "audio", audio }))
  }

  async open(): Promise<void> {}

  pull(): Promise<SpeechAudioFrame | SpeechEndFrame> {
    const frame = this.#frames.shift()
    return frame === undefined ? this.#end.promise : Promise.resolve(frame)
  }

  finish(): void {
    this.#end.resolve({ type: "done" })
  }

  cancel(): Promise<void> {
    this.cancelled = true
    this.finish()
    return Promise.resolve()
  }
}

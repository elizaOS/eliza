// spec/agent/voice/clientAudio.md, "The capture keeps a bounded prefix in arrival order while the meter keeps counting"; spec/agent/voice/clientAudio.md, "A WAV holds every sample in order as mono PCM16 behind a 44-byte header"
import type { CaptureAudioPort, CaptureContext, CaptureNode, ClipAudioPort, DecodedClip } from "../../src/voice/capture.vibe"
import { browserCaptureAudio } from "../../src/voice/capture-browser.ts"
import type { PlayerEvent, SpeechPlayer } from "../../src/voice/playback.vibe"

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
      await import(/* @vite-ignore */ url)
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

  async resume(): Promise<void> {
    this.resumed = true
  }

  async close(): Promise<void> {
    this.closed = true
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

export class FakePlayer implements SpeechPlayer {
  src = ""
  playbackRate = 1
  defaultPlaybackRate = 1
  preservesPitch = false
  paused = 0
  readonly listeners = new Map<PlayerEvent, Set<() => void>>()

  addEventListener(type: PlayerEvent, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
  }

  removeEventListener(type: PlayerEvent, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: PlayerEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  async play(): Promise<void> {}

  pause(): void {
    this.paused += 1
  }

  load(): void {}

  removeAttribute(): void {
    this.src = ""
  }
}

export function fakeClipAudio(duration: number, decoded: () => void = () => undefined): ClipAudioPort<DecodedClip> & { readonly rendered: number[] } {
  const rendered: number[] = []
  return {
    rendered,
    decode: async () => {
      decoded()
      return { duration }
    },
    render: async (_clip, length) => {
      rendered.push(length)
      return new Float32Array(length)
    },
  }
}

export function tone(value: number, samples: number): Float32Array {
  return new Float32Array(samples).fill(value)
}

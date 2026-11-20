// spec/agent/voice/clientAudio.md, "The capture keeps a bounded prefix in arrival order while the meter keeps counting"; spec/agent/voice/clientAudio.md, "A WAV holds every sample in order as mono PCM16 behind a 44-byte header"
import type { CaptureAudioPort, CaptureContext, CaptureNode, ClipAudioPort, DecodedClip } from "../../src/voice/capture.vibe"
import { captureProcessorName } from "../../src/voice/capture-browser.ts"

const renderQuantum = 128

interface SampleProcessor {
  process(inputs: Float32Array[][]): boolean
}

class WorkletPort {
  closed = false
  constructor(readonly deliver: (data: unknown) => void) {}
  postMessage(data: unknown): void {
    if (!this.closed) this.deliver(data)
  }
  close(): void {
    this.closed = true
  }
}

const processors = new Map<string, new () => SampleProcessor>()
let nextPort: WorkletPort | undefined

Object.assign(globalThis, {
  AudioWorkletProcessor: class {
    readonly port = nextPort
  },
  registerProcessor: (name: string, processor: new () => SampleProcessor) => processors.set(name, processor),
})

export class FakeMicrophone {
  tracksStopped = 0
  processor: SampleProcessor | undefined

  getTracks(): Array<{ stop(): void }> {
    return [{ stop: () => (this.tracksStopped += 1) }]
  }

  say(first: Float32Array, second: Float32Array = new Float32Array(first.length)): void {
    for (let start = 0; start < first.length; start += renderQuantum) {
      this.processor?.process([[first.subarray(start, start + renderQuantum), second.subarray(start, start + renderQuantum)]])
    }
  }
}

interface SampleNode extends CaptureNode {
  readonly processor: SampleProcessor
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
        stream.processor = (node as SampleNode).processor
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
    samples: (_context, receive) => {
      const Processor = processors.get(captureProcessorName)
      if (Processor === undefined) throw new Error(`no processor ${captureProcessorName}`)
      const port = new WorkletPort(receive)
      nextPort = port
      const processor = new Processor()
      nextPort = undefined
      const node: SampleNode = { processor, connect: () => undefined, disconnect: () => undefined }
      return { node, stop: () => port.close() }
    },
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

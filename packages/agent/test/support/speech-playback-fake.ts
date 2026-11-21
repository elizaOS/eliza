// spec/agent/voice/clientAudio.md, "A segment is played only once its input has ended and its audio has played"; spec/agent/voice/clientAudio.md, "The progressive attachment is ready at its first appended frame, or at the end without streaming"
import {
  SegmentedSpeechPlayback, type PlayerEvent, type ProgressiveSpeechSource, type SegmentedSpeechState, type SpeakOptions, type SpeechAudioFrame,
  type SpeechEndFrame, type SpeechMedia, type SpeechMediaSource, type SpeechPlayer, type SpeechSourceBuffer,
} from "../../src/voice/playback.vibe"

class Events<Name extends string> {
  readonly #listeners = new Map<Name, Set<() => void>>()
  addEventListener(type: Name, listener: () => void): void {
    const set = this.#listeners.get(type) ?? new Set()
    set.add(listener)
    this.#listeners.set(type, set)
  }
  removeEventListener(type: Name, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener)
  }
  fire(type: Name): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener()
  }
  count(): number {
    return [...this.#listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }
}

export class FakePlayer extends Events<PlayerEvent> implements SpeechPlayer {
  src = ""
  playbackRate = 1
  defaultPlaybackRate = 1
  preservesPitch = false
  plays = 0
  pauses = 0
  loads = 0
  refusal: unknown = undefined
  play(): Promise<void> {
    this.plays += 1
    return this.refusal === undefined ? Promise.resolve() : Promise.reject(this.refusal)
  }
  pause(): void {
    this.pauses += 1
  }
  load(): void {
    this.loads += 1
  }
  removeAttribute(): void {
    this.src = ""
  }
}

export interface AttachedSegment {
  readonly player: FakePlayer
  readonly text: string
  readonly ready: (renderedSpeed: number | null) => void
  readonly load: () => void
  disposed: number
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 2))

export function fakeSpeaker() {
  const attached: AttachedSegment[] = []
  const shown: SegmentedSpeechState[] = []
  const outcomes: Array<Promise<unknown>> = []
  const playback = new SegmentedSpeechPlayback({
    player: () => new FakePlayer(),
    attach: (player, text, { onReady }) => {
      let load = () => {}
      const loaded = new Promise<void>((resolve) => {
        load = () => resolve()
      })
      const entry: AttachedSegment = { player: player as FakePlayer, text, ready: onReady, load, disposed: 0 }
      attached.push(entry)
      return { loaded, dispose: () => { entry.disposed += 1 } }
    },
    changed: (state) => { shown.push(state) },
  })
  const current = (): AttachedSegment => {
    const entry = attached.at(-1)
    if (entry === undefined) throw new Error("no segment attached")
    return entry
  }
  const speak = (text: string, options?: SpeakOptions): number => {
    outcomes.push(playback.speak(text, options).then(() => "played", (failure: unknown) => failure))
    return outcomes.length - 1
  }
  const outcome = (index: number): Promise<unknown> => outcomes[index] ?? Promise.reject(new Error(`no reply ${index}`))
  const playThrough = async (audioFirst: boolean) => {
    const entry = current()
    entry.ready(null)
    await flush()
    if (audioFirst) entry.player.fire("ended")
    else entry.load()
    await flush()
    if (audioFirst) entry.load()
    else entry.player.fire("ended")
    await flush()
  }
  return { playback, attached, shown, current, speak, outcome, playThrough, flush }
}

class FakeBuffer extends Events<"updateend" | "error"> implements SpeechSourceBuffer {
  readonly appended: number[] = []
  appendBuffer(data: ArrayBuffer): void {
    this.appended.push(data.byteLength)
    queueMicrotask(() => this.fire("updateend"))
  }
}

class FakeMediaSource extends Events<"sourceopen" | "error"> implements SpeechMediaSource {
  readonly buffer = new FakeBuffer()
  ended = 0
  addSourceBuffer(): SpeechSourceBuffer {
    return this.buffer
  }
  endOfStream(): void {
    this.ended += 1
  }
}

export function fakeSpeechMedia(streams: boolean, player: FakePlayer) {
  const sources: FakeMediaSource[] = []
  const revoked: string[] = []
  const clips: Blob[] = []
  const media: SpeechMedia = {
    stream: streams
      ? () => {
        const source = new FakeMediaSource()
        sources.push(source)
        const url = `blob:stream-${sources.length}`
        queueMicrotask(() => { if (player.src === url) source.fire("sourceopen") })
        return { source, url }
      }
      : undefined,
    clipUrl: (clip) => {
      clips.push(clip)
      return `blob:clip-${clips.length}`
    },
    revokeUrl: (url) => { revoked.push(url) },
  }
  return { media, sources, revoked, clips }
}

export interface NumberedFrame extends SpeechAudioFrame {
  readonly seq: number
}

export function fakeSpeechSource(bytes: readonly number[]) {
  const gates: Array<() => void> = []
  let next = 0
  const counts = { opened: 0, cancelled: 0 }
  const source: ProgressiveSpeechSource<NumberedFrame> = {
    renderedSpeed: 1.1,
    open: async () => { counts.opened += 1 },
    pull: () => new Promise<NumberedFrame | SpeechEndFrame>((resolve) => {
      gates.push(() => {
        const size = bytes[next]
        next += 1
        resolve(size === undefined ? { type: "done" } : { type: "audio", audio: new Uint8Array(size).fill(next), seq: next })
      })
    }),
    cancel: async () => { counts.cancelled += 1 },
  }
  const release = async () => {
    await flush()
    gates.shift()?.()
    await flush()
  }
  return { source, counts, release }
}

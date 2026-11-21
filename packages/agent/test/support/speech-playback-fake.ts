// spec/agent/voice/clientAudio.md, "A segment is played only once its input has ended and its audio has played"; spec/agent/voice/clientAudio.md, "The progressive attachment is ready at its first appended frame, or at the end without streaming"
import {
  SegmentedSpeechPlayback, type PlayerEvent, type ProgressiveSpeechSource, type SegmentedSpeechState, type SpeakOptions, type SpeechAudioFrame,
  type SpeechEndFrame, type SpeechMedia, type SpeechMediaSource, type SpeechPlayer, type SpeechSourceBuffer,
} from "../../src/voice/playback.vibe"

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 2))

class Events<Name extends string> {
  readonly #listeners = new Map<Name, Set<() => void>>()
  /** @throws {never} */
  addEventListener(type: Name, listener: () => void): void {
    const set = this.#listeners.get(type) ?? new Set()
    set.add(listener)
    this.#listeners.set(type, set)
  }
  /** @throws {never} */
  removeEventListener(type: Name, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener)
  }
  /** @throws {never} */
  fire(type: Name): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener()
  }
  /** @throws {never} */
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
  /** @throws {never} */
  pause(): void {
    this.pauses += 1
  }
  /** @throws {never} */
  load(): void {
    this.loads += 1
  }
  /** @throws {never} */
  removeAttribute(): void {
    this.src = ""
  }
}

export class AttachedSegment {
  disposed = 0
  #ready: (renderedSpeed: number | null) => void
  #load: () => void
  constructor(readonly player: FakePlayer, readonly text: string, ready: (renderedSpeed: number | null) => void, load: () => void) {
    this.#ready = ready
    this.#load = load
  }
  /** @throws {never} */
  ready(renderedSpeed: number | null): void {
    this.#ready(renderedSpeed)
  }
  /** @throws {never} */
  load(): void {
    this.#load()
  }
}

export class FakeSpeaker {
  readonly attached: AttachedSegment[] = []
  readonly shown: SegmentedSpeechState[] = []
  readonly #outcomes: Array<Promise<unknown>> = []
  readonly #none = new AttachedSegment(new FakePlayer(), "", () => {}, () => {})
  readonly playback = new SegmentedSpeechPlayback({
    player: () => new FakePlayer(),
    attach: (player, text, { onReady }) => {
      let load = () => {}
      const loaded = new Promise<void>((resolve) => {
        load = () => resolve()
      })
      const entry = new AttachedSegment(player as FakePlayer, text, onReady, () => load())
      this.attached.push(entry)
      return { loaded, dispose: () => { entry.disposed += 1 } }
    },
    changed: (state) => { this.shown.push(state) },
  })

  /** @throws {never} */
  current(): AttachedSegment {
    return this.attached.at(-1) ?? this.#none
  }

  /** @throws {never} */
  speak(text: string, options?: SpeakOptions): number {
    this.#outcomes.push(this.playback.speak(text, options).then(() => "played", (failure: unknown) => failure))
    return this.#outcomes.length - 1
  }

  outcome(index: number): Promise<unknown> {
    return this.#outcomes[index] ?? Promise.resolve(`no reply ${index}`)
  }

  flush(): Promise<void> {
    return flush()
  }

  async playThrough(audioFirst: boolean): Promise<void> {
    const entry = this.current()
    entry.ready(null)
    await flush()
    if (audioFirst) entry.player.fire("ended")
    else entry.load()
    await flush()
    if (audioFirst) entry.load()
    else entry.player.fire("ended")
    await flush()
  }
}

class FakeBuffer extends Events<"updateend" | "error"> implements SpeechSourceBuffer {
  readonly appended: number[] = []
  /** @throws {never} */
  appendBuffer(data: ArrayBuffer): void {
    this.appended.push(data.byteLength)
    queueMicrotask(() => this.fire("updateend"))
  }
}

class FakeMediaSource extends Events<"sourceopen" | "error"> implements SpeechMediaSource {
  readonly buffer = new FakeBuffer()
  ended = 0
  /** @throws {never} */
  addSourceBuffer(): SpeechSourceBuffer {
    return this.buffer
  }
  /** @throws {never} */
  endOfStream(): void {
    this.ended += 1
  }
}

export interface FakeSpeechMedia {
  readonly media: SpeechMedia
  readonly sources: readonly FakeMediaSource[]
  readonly revoked: readonly string[]
  readonly clips: readonly Blob[]
}

/** @throws {never} */
export function fakeSpeechMedia(streams: boolean, player: FakePlayer): FakeSpeechMedia {
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

export interface FakeSpeechSource {
  readonly source: ProgressiveSpeechSource<NumberedFrame>
  readonly counts: { readonly opened: number; readonly cancelled: number }
  release(): Promise<void>
}

/** @throws {never} */
export function fakeSpeechSource(bytes: readonly number[]): FakeSpeechSource {
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

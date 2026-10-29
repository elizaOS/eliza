/**
 * Per-turn voice latency records, kept only on this device (`@elizaos/voice/turn-timing`).
 *
 * A record holds a random turn id, the speech route, whether the turn was cold, and millisecond
 * offsets from the end of the user's input. It never holds transcript or reply text, account,
 * agent or conversation identifiers. `exportJson()` produces the document a latency aggregator
 * reads; the host names its format and storage key so installed records keep their identity.
 *
 * Marks (`VOICE_TIMING_MARKS`): recording-end (offset 0, the last user input), transcript-ready,
 * send, first-token, final-reply, first-audio (the first audible reply sample the playback layer
 * reports). Each mark is recorded once (first wins) and must not precede an earlier mark, so a
 * late or out-of-order observation cannot shorten a measured phase. Reply and audio marks need a
 * send mark; send needs a ready transcript. A turn ends at first-audio, at `finish` (no audio will
 * follow) or at `abandon` (cancelled, discarded, typed instead), which keeps it as abandoned.
 *
 * A record started by an entrypoint also names that entry (for example `conversation` for voice
 * conversation, auto-submitting, or a dictation entry that fills an editable draft) and the send
 * policy in force (`auto-send` or `review`). Marks are raw: whether review time counts toward a
 * target is decided by the aggregator, never by moving a mark.
 *
 * Optional sections, numbers and enums only: `live` (streaming ASR mode, partial count and
 * speech-end to final), `endpoint` (whether the semantic end-of-turn scorer or the long silence
 * gap submitted the turn, the scorer's outcome and unavailable reason, and which end-of-turn chain
 * stage answered: `local` or `clef`) and `heard` (the heard-route
 * outcome after an interruption).
 *
 * Conversation-entry transcript-ready, send and first-token marks are also reported to a native
 * latency collector through a sink the platform installs (`setNativeStageSink`); native stamps
 * them on its monotonic clock and links them to its capture turn by a random native turn id,
 * which the record keeps as `nativeTurn`. Only the stage name and that id cross the bridge.
 *
 * Timing is diagnostic: storage failures and sink failures never affect a voice turn.
 */
import {
  CLEF_ENDPOINT_UNAVAILABLE_REASONS,
  type ClefEndpointUnavailableReason,
  type EndpointPath,
} from "./voice-endpoint-chain.js";
import type {
  EndOfTurnUnavailableReason,
  HeardOutcome,
} from "./voice-turn-routes.js";

export const VOICE_TIMING_MARKS = [
  "recording-end",
  "transcript-ready",
  "send",
  "first-token",
  "final-reply",
  "first-audio",
] as const;
export type VoiceTimingMark = (typeof VOICE_TIMING_MARKS)[number];
export type VoiceTimingPolicy = "auto-send" | "review";
export interface VoiceTimingLive {
  mode: "stream" | "batch" | "unknown";
  partials: number;
  firstPartialMs?: number;
  finalFromSpeechEndMs?: number;
  asrFinalFromSpeechEndMs?: number;
}
export type VoiceTimingSemantic =
  | "complete"
  | "incomplete"
  | "unavailable"
  | "timeout"
  | "error"
  | "not-asked";
export interface VoiceTimingEndpoint {
  by: "semantic" | "gap";
  semantic: VoiceTimingSemantic;
  reason?: EndOfTurnUnavailableReason | ClefEndpointUnavailableReason;
  latencyMs?: number;
  /** The end-of-turn chain stage that answered: the local scorer or Clef. */
  path?: EndpointPath;
}
export interface VoiceTimingRecord {
  version: 1;
  id: string;
  recordedAt: number;
  route: string;
  cold: boolean;
  entry?: string;
  policy?: VoiceTimingPolicy;
  marks: Partial<Record<VoiceTimingMark, number>>;
  live?: VoiceTimingLive;
  endpoint?: VoiceTimingEndpoint;
  heard?: HeardOutcome;
  nativeTurn?: string;
  outcome?: "abandoned";
}
/** Native collector stages fed by renderer marks. */
export type NativeVoiceStage = "asr-final" | "request" | "first-token";
/** Reports one stage; resolves with the native turn id it was bound to, if any. */
export type NativeVoiceStageSink = (
  stage: NativeVoiceStage,
  voiceTurnId?: string,
) => Promise<string | undefined>;

export interface VoiceTimingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface VoiceTurnTimingOptions {
  /** Where records live; a host keeps its installed key. */
  storageKey: string;
  /** Export document format identifier. */
  format: string;
  /** Speech routes a record may name; anything else is not recorded. */
  routes: readonly string[];
  /** Entry names a record may carry. Default: conversation, dictation. */
  entries?: readonly string[];
  /** The entry whose marks feed the native collector. Default: conversation. */
  nativeEntry?: string;
  /** Records kept, newest last. Default 200. */
  limit?: number;
  /** Storage resolver, read at each access. Default: the global localStorage. */
  storage?: () => VoiceTimingStorage | undefined;
  /** Monotonic millisecond clock. Default: performance.now (Date.now without it). */
  clock?: () => number;
}

const MAX_OFFSET_MS = 3_600_000;
const nativeVoiceStages: Partial<Record<VoiceTimingMark, NativeVoiceStage>> = {
  "transcript-ready": "asr-final",
  send: "request",
  "first-token": "first-token",
};
const nativeTurnPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const liveNumbers = [
  "firstPartialMs",
  "finalFromSpeechEndMs",
  "asrFinalFromSpeechEndMs",
] as const;
const endpointBy = ["semantic", "gap"];
const endpointOutcomes: readonly string[] = [
  "complete",
  "incomplete",
  "unavailable",
  "timeout",
  "error",
  "not-asked",
];
const endpointReasons: readonly string[] = [
  "voice-not-started",
  "ffi-context-unloaded",
  "scorer-unsupported",
  "ram-pressure",
  "unscored",
  "timeout",
  "too-long",
  "invalid-response",
  "unknown",
  ...CLEF_ENDPOINT_UNAVAILABLE_REASONS,
];
const endpointPaths: readonly string[] = ["local", "clef"];
const heardOutcomes: readonly string[] = [
  "recorded",
  "unchanged",
  "not-needed",
  "nothing-heard",
  "conflict",
  "not-found",
  "unavailable",
  "rejected",
  "stale",
  "invalid",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isOffset = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value < MAX_OFFSET_MS;

/** The `live` numbers of a record, or undefined when the value is not exactly that shape. */
export function voiceTimingLive(value: unknown): VoiceTimingLive | undefined {
  if (!isRecord(value)) return undefined;
  const partials = value.partials;
  if (
    !["stream", "batch", "unknown"].includes(value.mode as string) ||
    typeof partials !== "number" ||
    !Number.isSafeInteger(partials) ||
    partials < 0 ||
    partials > 100000
  )
    return undefined;
  const out: VoiceTimingLive = {
    mode: value.mode as VoiceTimingLive["mode"],
    partials,
  };
  for (const key of liveNumbers) {
    const at = value[key];
    if (at === undefined) continue;
    if (!isOffset(at)) return undefined;
    out[key] = Math.round(at);
  }
  return out;
}

/** The `endpoint` enums of a record, or undefined when the value is not exactly that shape. */
export function voiceTimingEndpoint(
  value: unknown,
): VoiceTimingEndpoint | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !endpointBy.includes(value.by as string) ||
    !endpointOutcomes.includes(value.semantic as string)
  )
    return undefined;
  // Only a complete semantic verdict submits a turn by the scorer.
  if (value.by === "semantic" && value.semantic !== "complete")
    return undefined;
  const out: VoiceTimingEndpoint = {
    by: value.by as VoiceTimingEndpoint["by"],
    semantic: value.semantic as VoiceTimingSemantic,
  };
  if (value.reason !== undefined) {
    if (!endpointReasons.includes(value.reason as string)) return undefined;
    out.reason = value.reason as VoiceTimingEndpoint["reason"];
  }
  if (value.path !== undefined) {
    if (!endpointPaths.includes(value.path as string)) return undefined;
    out.path = value.path as EndpointPath;
  }
  if (value.latencyMs !== undefined) {
    if (!isOffset(value.latencyMs)) return undefined;
    out.latencyMs = Math.round(value.latencyMs);
  }
  return out;
}

export interface VoiceTurnTiming {
  readonly format: string;
  readonly marks: readonly VoiceTimingMark[];
  /** Every stored record that passes validation, oldest first. */
  records(): VoiceTimingRecord[];
  /** Start a turn at the end of user input. Any unfinished turn is abandoned. */
  begin(input: {
    route: string;
    cold: boolean;
    entry?: string;
    policy?: VoiceTimingPolicy;
  }): string | undefined;
  /** Record one mark for the active turn (or the named turn while it is still active). */
  mark(mark: VoiceTimingMark, turn?: string): boolean;
  /** Installs (or, with undefined, removes) the native stage reporter. */
  setNativeStageSink(sink: NativeVoiceStageSink | undefined): void;
  /** The native latency turn the active turn is linked to, for its reply's synthesis. */
  nativeTurnId(): string | undefined;
  /** Attach live ASR numbers to the active turn (or the named one while it is still active). */
  recordLive(live: unknown, turn?: string): boolean;
  /** Attach how the active turn was endpointed. */
  recordEndpoint(endpoint: unknown, turn?: string): boolean;
  /** Attach the heard outcome to a stored turn by id (it may already have finished). First wins. */
  recordHeard(turn: string | undefined, heard: unknown): boolean;
  /** The turn ended without a reply. Kept as abandoned unless a final reply was marked. */
  abandon(): void;
  /** Finish the active turn after its final reply when no audio will follow. */
  finish(turn?: string): void;
  active(): string | undefined;
  /**
   * The send boundary of one entry turn whose transcript is ready. `auto-send` sends the
   * transcript as it is; `review` sends only what `review` confirms (null discards it). The send
   * mark is taken at that boundary. A discarded or failed send abandons the turn it was bound to,
   * never a later one. Resolves null when nothing was sent.
   */
  sendEntry<T>(input: {
    policy: VoiceTimingPolicy;
    transcript: string;
    review: (text: string) => Promise<string | null>;
    send: (text: string) => Promise<T>;
  }): Promise<{ text: string; result: T } | null>;
  /** JSON export for a latency aggregator. Contains no text or account identifiers. */
  exportJson(): string;
  clear(): void;
  /** Test hook: a deterministic clock. */
  setClock(clock: () => number): void;
}

const defaultClock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
const defaultStorage = (): VoiceTimingStorage | undefined => {
  try {
    return (globalThis as { localStorage?: VoiceTimingStorage }).localStorage;
  } catch {
    return undefined;
  }
};

export function createVoiceTurnTiming(
  options: VoiceTurnTimingOptions,
): VoiceTurnTiming {
  const entries = options.entries ?? ["conversation", "dictation"];
  const nativeEntry = options.nativeEntry ?? "conversation";
  const limit = options.limit ?? 200;
  const routes = [...options.routes];
  const order = VOICE_TIMING_MARKS as readonly string[];
  let clock = options.clock ?? defaultClock;
  let sink: NativeVoiceStageSink | undefined;
  let active:
    | { id: string; base: number; entry?: string; native?: string }
    | undefined;

  const store = () => {
    try {
      return (options.storage ?? defaultStorage)();
    } catch {
      return undefined;
    }
  };
  const valid = (value: unknown): value is VoiceTimingRecord => {
    if (!isRecord(value)) return false;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.id) ||
      !Number.isFinite(value.recordedAt) ||
      typeof value.cold !== "boolean" ||
      !routes.includes(value.route as string)
    )
      return false;
    if (
      (value.entry !== undefined && !entries.includes(value.entry as string)) ||
      (value.policy !== undefined &&
        value.policy !== "auto-send" &&
        value.policy !== "review")
    )
      return false;
    if (!isRecord(value.marks)) return false;
    if (value.live !== undefined && !voiceTimingLive(value.live)) return false;
    if (value.endpoint !== undefined && !voiceTimingEndpoint(value.endpoint))
      return false;
    if (
      value.heard !== undefined &&
      !heardOutcomes.includes(value.heard as string)
    )
      return false;
    if (
      value.nativeTurn !== undefined &&
      (typeof value.nativeTurn !== "string" ||
        !nativeTurnPattern.test(value.nativeTurn))
    )
      return false;
    if (value.outcome !== undefined && value.outcome !== "abandoned")
      return false;
    return Object.entries(value.marks).every(
      ([key, at]) => order.includes(key) && isOffset(at),
    );
  };
  const records = (): VoiceTimingRecord[] => {
    try {
      const raw = store()?.getItem(options.storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch {
      return [];
    }
  };
  const save = (row: VoiceTimingRecord) => {
    try {
      const rows = records().filter((item) => item.id !== row.id);
      rows.push(row);
      store()?.setItem(options.storageKey, JSON.stringify(rows.slice(-limit)));
    } catch {
      /* Timing is diagnostic; it never blocks a voice turn. */
    }
  };
  const find = (id: string) => records().find((item) => item.id === id);

  const forwardNative = (
    mark: VoiceTimingMark,
    turn: { id: string; entry?: string; native?: string },
  ) => {
    const stage = nativeVoiceStages[mark];
    const report = sink;
    if (!stage || !report || turn.entry !== nativeEntry) return;
    let pending: Promise<string | undefined>;
    try {
      pending = Promise.resolve(report(stage, turn.native));
    } catch {
      return;
    }
    void pending
      .then((id) => {
        if (
          typeof id !== "string" ||
          !nativeTurnPattern.test(id) ||
          (turn.native !== undefined && turn.native !== id)
        )
          return;
        turn.native = id;
        const row = find(turn.id);
        if (row && row.nativeTurn === undefined) {
          row.nativeTurn = id;
          save(row);
        }
      })
      .catch(() => {
        /* Diagnostic only. */
      });
  };

  const abandon = () => {
    const current = active;
    active = undefined;
    if (!current) return;
    const row = find(current.id);
    if (row && row.marks["final-reply"] === undefined)
      save({ ...row, outcome: "abandoned" });
  };

  const mark = (name: VoiceTimingMark, turn?: string): boolean => {
    const current = active;
    if (
      !current ||
      (turn !== undefined && turn !== current.id) ||
      !order.includes(name)
    )
      return false;
    const row = find(current.id);
    if (!row || row.outcome || row.marks[name] !== undefined) return false;
    const at = Math.max(0, Math.round(clock() - current.base));
    const index = order.indexOf(name);
    // Reply and audio marks measure from send; send measures from a ready transcript.
    if (index >= 3 && row.marks.send === undefined) return false;
    if (name === "send" && row.marks["transcript-ready"] === undefined)
      return false;
    if (
      VOICE_TIMING_MARKS.slice(0, index).some(
        (prior) => (row.marks[prior] ?? -1) > at,
      )
    )
      return false;
    row.marks[name] = at;
    save(row);
    forwardNative(name, current);
    if (name === "first-audio") active = undefined;
    return true;
  };

  const attach = <K extends "live" | "endpoint">(
    key: K,
    value: VoiceTimingRecord[K] | undefined,
    turn?: string,
  ) => {
    const current = active;
    if (!current || !value || (turn !== undefined && turn !== current.id))
      return false;
    const row = find(current.id);
    if (!row || row.outcome || row[key]) return false;
    row[key] = value;
    save(row);
    return true;
  };

  return {
    format: options.format,
    marks: VOICE_TIMING_MARKS,
    records,
    begin(input) {
      abandon();
      if (
        !routes.includes(input.route) ||
        typeof crypto === "undefined" ||
        typeof crypto.randomUUID !== "function"
      )
        return undefined;
      const id = crypto.randomUUID();
      const entry =
        input.entry !== undefined && entries.includes(input.entry)
          ? input.entry
          : undefined;
      const policy =
        input.policy === "auto-send" || input.policy === "review"
          ? input.policy
          : undefined;
      active = { id, base: clock(), ...(entry ? { entry } : {}) };
      save({
        version: 1,
        id,
        recordedAt: Date.now(),
        route: input.route,
        cold: input.cold === true,
        ...(entry ? { entry } : {}),
        ...(policy ? { policy } : {}),
        marks: { "recording-end": 0 },
      });
      return id;
    },
    mark,
    setNativeStageSink(next) {
      sink = next;
    },
    nativeTurnId: () => active?.native,
    recordLive: (live, turn) => attach("live", voiceTimingLive(live), turn),
    recordEndpoint: (endpoint, turn) =>
      attach("endpoint", voiceTimingEndpoint(endpoint), turn),
    recordHeard(turn, heard) {
      if (typeof turn !== "string" || !heardOutcomes.includes(heard as string))
        return false;
      const row = find(turn);
      if (!row || row.heard) return false;
      row.heard = heard as HeardOutcome;
      save(row);
      return true;
    },
    abandon,
    finish(turn) {
      if (active && (turn === undefined || turn === active.id))
        active = undefined;
    },
    active: () => active?.id,
    async sendEntry(input) {
      // Bound to the turn active now; a later turn is never marked or abandoned by this one.
      const turn = active?.id;
      const retire = () => {
        if (turn !== undefined && turn === active?.id) abandon();
      };
      let text: string | null = input.transcript;
      try {
        if (input.policy === "review")
          text = await input.review(input.transcript);
      } catch (error) {
        retire();
        throw error;
      }
      text = typeof text === "string" ? text.trim() : "";
      if (!text) {
        retire();
        return null;
      }
      if (turn !== undefined) mark("send", turn);
      try {
        return { text, result: await input.send(text) };
      } catch (error) {
        retire();
        throw error;
      }
    },
    exportJson: () =>
      JSON.stringify(
        {
          format: options.format,
          exportedAt: new Date().toISOString(),
          marks: VOICE_TIMING_MARKS,
          records: records(),
        },
        null,
        2,
      ),
    clear() {
      active = undefined;
      try {
        store()?.removeItem(options.storageKey);
      } catch {
        /* Nothing stored. */
      }
    },
    setClock(next) {
      clock = next;
    },
  };
}

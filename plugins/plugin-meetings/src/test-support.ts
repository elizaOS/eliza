/**
 * Test seams for the meetings orchestration layer: an in-memory runtime stub
 * that implements the exact runtime surface the service/writer/routes use
 * (memories partition, world/room/entity upserts, service lookup), a scripted
 * pipeline, and a scriptable platform adapter. Used by the vitest suites; not
 * exported from the package root.
 */

import type { IAgentRuntime, Memory, Plugin, UUID } from "@elizaos/core";
import type {
  MeetingBillingState,
  MeetingEndReason,
  MeetingParticipant,
  MeetingPlatform,
  MeetingSessionStatus,
} from "@elizaos/shared";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import {
  type MeetingPipelineInstance,
  MeetingService,
  type MeetingServiceDependencies,
} from "./service.js";
import type {
  MeetingBillingSession,
  MeetingBotSession,
  MeetingPipelineOptions,
  MeetingPlatformAdapter,
  PipelineTranscriptUpdate,
} from "./types.js";
import { MeetingBillingError } from "./types.js";

export interface FakeRuntime {
  runtime: IAgentRuntime;
  memories: Map<string, Memory>;
  tables: Map<string, string>;
  worlds: Array<Record<string, unknown>>;
  rooms: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  broadcasts: object[];
  documents: Array<Record<string, unknown>>;
  settings: Record<string, string>;
}

export function makeFakeRuntime(): FakeRuntime {
  const memories = new Map<string, Memory>();
  const tables = new Map<string, string>();
  const worlds: Array<Record<string, unknown>> = [];
  const rooms: Array<Record<string, unknown>> = [];
  const entities: Array<Record<string, unknown>> = [];
  const broadcasts: object[] = [];
  const documents: Array<Record<string, unknown>> = [];
  const settings: Record<string, string> = {};

  const connectorSetup = {
    broadcastWs: (data: object) => {
      broadcasts.push(data);
    },
  };
  const documentsService = {
    addDocument: async (options: Record<string, unknown>) => {
      documents.push(options);
      return { storedDocumentMemoryId: crypto.randomUUID() as UUID };
    },
  };

  const runtime = {
    agentId: "00000000-0000-0000-0000-00000000a9e7" as UUID,
    character: { name: "Eliza" },
    getSetting: (key: string) => settings[key] ?? null,
    getService: (name: string) => {
      if (name === "connector-setup") return connectorSetup;
      if (name === "documents") return documentsService;
      return null;
    },
    ensureWorldExists: async (world: Record<string, unknown>) => {
      worlds.push(world);
    },
    ensureRoomExists: async (room: Record<string, unknown>) => {
      rooms.push(room);
    },
    createEntity: async (entity: Record<string, unknown>) => {
      entities.push(entity);
      return true;
    },
    createMemory: async (memory: Memory, tableName: string) => {
      memories.set(memory.id as string, memory);
      tables.set(memory.id as string, tableName);
      return memory.id as UUID;
    },
    getMemoryById: async (id: UUID) => memories.get(id) ?? null,
    updateMemory: async (patch: Partial<Memory> & { id: UUID }) => {
      const existing = memories.get(patch.id);
      if (!existing) return false;
      memories.set(patch.id, { ...existing, ...patch });
      return true;
    },
  } as unknown as IAgentRuntime;

  return {
    runtime,
    memories,
    tables,
    worlds,
    rooms,
    entities,
    broadcasts,
    documents,
    settings,
  };
}

/** A scripted pipeline the test drives directly. */
export class ScriptedPipeline implements MeetingPipelineInstance {
  updates: Array<(update: PipelineTranscriptUpdate) => void> = [];
  pushed: Array<{ speakerKey: string; samples: Float32Array }> = [];
  named = new Map<string, string>();
  flushed: string[] = [];
  joined: MeetingParticipant[] = [];
  left: Array<{ participantId: string; atMs: number }> = [];
  finalSegments: TranscriptSegment[] = [];
  finalizeError: Error | null = null;
  audioWav: Buffer | null = null;
  finalized = false;

  pushSpeakerAudio(speakerKey: string, samples: Float32Array): void {
    this.pushed.push({ speakerKey, samples });
  }
  setSpeakerName(speakerKey: string, displayName: string): void {
    this.named.set(speakerKey, displayName);
  }
  flushSpeaker(speakerKey: string): void {
    this.flushed.push(speakerKey);
  }
  participantJoined(participant: MeetingParticipant): void {
    this.joined.push(participant);
  }
  participantLeft(participantId: string, atMs: number): void {
    this.left.push({ participantId, atMs });
  }
  onUpdate(listener: (update: PipelineTranscriptUpdate) => void): () => void {
    this.updates.push(listener);
    return () => {
      this.updates = this.updates.filter((l) => l !== listener);
    };
  }
  emit(update: PipelineTranscriptUpdate): void {
    for (const listener of this.updates) listener(update);
  }
  async finalize(): Promise<TranscriptSegment[]> {
    this.finalized = true;
    if (this.finalizeError) throw this.finalizeError;
    return this.finalSegments;
  }
  speakerNames(): string[] {
    return [...new Set(this.named.values())];
  }
  sessionAudioWav(): Buffer | null {
    return this.audioWav;
  }
}

export class FakeMeetingBillingSession implements MeetingBillingSession {
  readonly state: MeetingBillingState = {
    status: "reserved",
    reservedMs: 0,
    consumedMs: 0,
    capMs: 60_000,
    reservationIds: [] as string[],
  };
  initialReserveError: Error | null = null;
  failAfterConsumedMs: number | null = null;
  reserveInitialCalls = 0;
  reconcileCalls: MeetingEndReason[] = [];

  constructor(options?: { capMs?: number; reservedMs?: number }) {
    this.state.capMs = options?.capMs ?? this.state.capMs;
    this.state.reservedMs = options?.reservedMs ?? 0;
  }

  async reserveInitial(): Promise<void> {
    this.reserveInitialCalls += 1;
    if (this.initialReserveError) throw this.initialReserveError;
    if (this.state.reservedMs === 0) this.state.reservedMs = 15_000;
    this.state.reservationIds?.push(`reserve-${this.reserveInitialCalls}`);
  }

  async ensureTranscriptionWindow(durationMs: number): Promise<void> {
    const nextConsumed = this.state.consumedMs + durationMs;
    if (
      this.failAfterConsumedMs !== null &&
      nextConsumed > this.failAfterConsumedMs
    ) {
      this.state.status = "spend_cap_reached";
      this.state.error = "insufficient credits for meeting transcription";
      throw new MeetingBillingError(
        "insufficient_credits",
        "insufficient credits for meeting transcription",
      );
    }
    this.state.consumedMs = nextConsumed;
    while (this.state.reservedMs < nextConsumed) {
      this.state.reservedMs += 15_000;
      this.state.reservationIds?.push(
        `reserve-${this.state.reservationIds.length + 1}`,
      );
    }
  }

  async reconcile(reason: MeetingEndReason) {
    this.reconcileCalls.push(reason);
    this.state.status = "reconciled";
    return this.state;
  }
}

/** An adapter whose lifecycle the test resolves/queues explicitly. */
export class ScriptedAdapter implements MeetingPlatformAdapter {
  session: MeetingBotSession | null = null;
  private resolveRun!: (reason: MeetingEndReason) => void;
  private rejectRun!: (err: Error) => void;
  readonly started: Promise<MeetingBotSession>;
  private markStarted!: (session: MeetingBotSession) => void;

  constructor(readonly platform: MeetingPlatform) {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  run(session: MeetingBotSession): Promise<MeetingEndReason> {
    this.session = session;
    this.markStarted(session);
    return new Promise((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
    });
  }

  report(status: MeetingSessionStatus): void {
    this.session?.reportStatus(status);
  }
  end(reason: MeetingEndReason): void {
    this.resolveRun(reason);
  }
  fail(err: Error): void {
    this.rejectRun(err);
  }
}

export function segment(
  id: string,
  speaker: string,
  text: string,
  startMs: number,
  endMs: number,
): TranscriptSegment {
  return { id, speakerLabel: speaker, startMs, endMs, text, words: [] };
}

// ---------------------------------------------------------------------------
// Mock injection seam for the scenario-runner (browser-free, ASR-free E2E).
//
// The real plugin wires MeetingService.dependencyFactory to the browser
// adapters + runtime-model ASR pipeline at module load (src/index.ts). For a
// mocked scenario lane we override that factory with a MOCK one: a
// MockMeetingAdapter that drives the audio sink with scripted speakers +
// participants and reports a joining → active → (leave) lifecycle, and a
// MockTranscriptionPipeline that emits deterministic TranscriptSegments and
// returns them on finalize(). The rest of the path (actions, service state
// machine, transcript writer, knowledge mirror) is the REAL code.
//
// A scenario installs the mock via a `custom` seed that:
//   1. `await import("@elizaos/plugin-meetings")` — runs the real index.ts once
//      (which sets the real dependencyFactory) and caches the ESM module, so the
//      runner's later `requires.plugins` import returns the cached module and
//      does NOT re-run the real assignment.
//   2. `installMockMeetingDependencies()` — overwrites dependencyFactory with
//      the mock. The meetings service is constructed AFTER seeds run (during
//      `requires.plugins` registration), so it reads the mock factory. See
//      test/scenarios/_meetings-mock.ts.
// ---------------------------------------------------------------------------

/** A scripted speaker turn the mock pipeline emits as a confirmed segment. */
export interface MockSpeakerTurn {
  speakerKey: string;
  displayName: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** Behavior of one mocked meeting, keyed by canonical native meeting id. */
export interface MockMeetingScript {
  /**
   * Keep the session `active` until the user requests a leave (abort) — like a
   * real bot sitting in a call. When false, the bot auto-ends after emitting so
   * the transcript finalizes to `ready` within the scenario.
   */
  holdUntilLeave: boolean;
  turns: MockSpeakerTurn[];
}

const MOCK_AUDIO_SAMPLE_RATE = 16_000;

/** Default 16 kHz mono PCM chunk a scripted turn "captures" (deterministic). */
function fakePcm(ms: number): Float32Array {
  const samples = Math.max(1, Math.round((MOCK_AUDIO_SAMPLE_RATE * ms) / 1000));
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.sin(i / 8) * 0.1;
  return pcm;
}

/** Two speakers, one exchange — the canned transcript most scenarios assert. */
export const DEFAULT_MOCK_TURNS: MockSpeakerTurn[] = [
  {
    speakerKey: "s1",
    displayName: "Alice",
    text: "Hi everyone, thanks for joining the sync.",
    startMs: 0,
    endMs: 2_500,
  },
  {
    speakerKey: "s2",
    displayName: "Bob",
    text: "Happy to be here — let us review the roadmap.",
    startMs: 2_600,
    endMs: 5_400,
  },
];

/**
 * Registry the mock adapter + pipeline read at run time, keyed by canonical
 * native meeting id. A scenario seeds this before the meeting starts. When a
 * meeting id is absent, the default (auto-end, canned two-speaker) script runs.
 */
const mockScripts = new Map<string, MockMeetingScript>();

export function setMockMeetingScript(
  nativeMeetingId: string,
  script: MockMeetingScript,
): void {
  mockScripts.set(nativeMeetingId, script);
}

export function clearMockMeetingScripts(): void {
  mockScripts.clear();
}

function scriptFor(nativeMeetingId: string): MockMeetingScript {
  return (
    mockScripts.get(nativeMeetingId) ?? {
      holdUntilLeave: false,
      turns: DEFAULT_MOCK_TURNS,
    }
  );
}

/**
 * Mock transcription pipeline: buffers nothing, emits the scripted turns as
 * confirmed segments (so the live update + persistence path fires) and returns
 * them on finalize(). Fully deterministic; no ASR, no runtime model call.
 */
export class MockTranscriptionPipeline implements MeetingPipelineInstance {
  private listeners: Array<(u: PipelineTranscriptUpdate) => void> = [];
  private readonly confirmed: TranscriptSegment[] = [];
  private readonly names = new Set<string>();

  pushSpeakerAudio(): void {}
  setSpeakerName(_speakerKey: string, displayName: string): void {
    this.names.add(displayName);
  }
  flushSpeaker(): void {}
  participantJoined(participant: MeetingParticipant): void {
    this.names.add(participant.displayName);
  }
  participantLeft(): void {}

  onUpdate(listener: (u: PipelineTranscriptUpdate) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Publish one scripted line as a confirmed segment — the mock ASR "resolving"
   * a flushed speaker buffer. Driven by the adapter, which owns the script.
   */
  emitTurn(turn: MockSpeakerTurn): void {
    const seg: TranscriptSegment = {
      id: `${turn.speakerKey}-${turn.startMs}`,
      speakerLabel: turn.displayName,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
      words: [],
    };
    this.confirmed.push(seg);
    this.names.add(turn.displayName);
    for (const listener of this.listeners) {
      listener({ confirmed: [seg], pending: [] });
    }
  }

  async finalize(): Promise<TranscriptSegment[]> {
    return [...this.confirmed];
  }
  speakerNames(): string[] {
    return [...this.names];
  }
  sessionAudioWav(): Buffer | null {
    return null;
  }
}

/**
 * Mock platform adapter: reports joining → active, drives the sink with the
 * scripted participants + turns (which flow into the real service roster/entity
 * wiring and the mock pipeline), then either holds until the user leaves
 * (abort → `requested_stop`) or ends immediately (`normal_completion`). Never
 * launches a browser.
 */
export class MockMeetingAdapter implements MeetingPlatformAdapter {
  constructor(
    readonly platform: MeetingPlatform,
    private readonly nextPipeline: () => MockTranscriptionPipeline,
  ) {}

  async run(session: MeetingBotSession): Promise<MeetingEndReason> {
    const script = scriptFor(session.config.nativeMeetingId);
    // The pipeline the service just created for this same session (FIFO handoff).
    const pipeline = this.nextPipeline();
    session.reportStatus("joining");
    session.reportStatus("active");

    const speakers = new Set<string>();
    for (const turn of script.turns) {
      if (!speakers.has(turn.speakerKey)) {
        speakers.add(turn.speakerKey);
        session.sink.participantJoined({
          id: turn.speakerKey,
          displayName: turn.displayName,
          joinedAtMs: turn.startMs,
        });
      }
      session.sink.setSpeakerName(turn.speakerKey, turn.displayName);
      session.sink.pushSpeakerAudio(
        turn.speakerKey,
        fakePcm(turn.endMs - turn.startMs),
      );
      session.sink.flushSpeaker(turn.speakerKey);
      // The mock ASR "resolves" the flushed line into a confirmed segment.
      pipeline.emitTurn(turn);
    }

    if (!script.holdUntilLeave) {
      return "normal_completion";
    }
    // Sit in the meeting until the user asks the bot to leave (abort signal).
    await new Promise<void>((resolve) => {
      if (session.signal.aborted) return resolve();
      session.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "requested_stop";
  }
}

/**
 * Build the mock MeetingServiceDependencies. `createPipeline` enqueues each new
 * pipeline; the adapter (whose `run` the service calls right after, on the same
 * session, before any other join can interleave) dequeues it — a FIFO handoff
 * that lets the adapter drive scripted turns onto exactly that session's
 * pipeline without service.ts changes.
 */
export function mockMeetingDependencies(): MeetingServiceDependencies {
  const pipelineQueue: MockTranscriptionPipeline[] = [];
  const nextPipeline = (): MockTranscriptionPipeline => {
    const pipeline = pipelineQueue.shift();
    if (!pipeline) {
      throw new Error(
        "[MockMeetingAdapter] no pipeline queued for this session",
      );
    }
    return pipeline;
  };
  const adapters = new Map<MeetingPlatform, MeetingPlatformAdapter>([
    ["google_meet", new MockMeetingAdapter("google_meet", nextPipeline)],
    ["teams", new MockMeetingAdapter("teams", nextPipeline)],
    ["zoom", new MockMeetingAdapter("zoom", nextPipeline)],
  ]);
  return {
    adapters,
    createPipeline: (_options: MeetingPipelineOptions) => {
      const pipeline = new MockTranscriptionPipeline();
      pipelineQueue.push(pipeline);
      return pipeline;
    },
  };
}

/**
 * Overwrite MeetingService.dependencyFactory with the mock. Call AFTER the real
 * plugin module has been imported (so its module-load real assignment already
 * ran and the ESM module is cached) and BEFORE the meetings service starts.
 */
export function installMockMeetingDependencies(): void {
  MeetingService.dependencyFactory = () => mockMeetingDependencies();
}

/**
 * A tiny companion plugin whose only job is to install the mock dependency
 * factory during `init` — an alternative to the seed path for hosts that load
 * plugins via the plugin array. Its `init` runs before service `start`.
 */
export const mockMeetingsCompanionPlugin: Plugin = {
  name: "meetings-mock-companion",
  description: "Installs the mock MeetingService dependency factory for tests",
  init: async () => {
    installMockMeetingDependencies();
  },
};

/** One-line factory: pipeline + deps for a MeetingService under test. */
export function scriptedDeps(
  adapters: MeetingPlatformAdapter[],
  billingSessions: FakeMeetingBillingSession[] = [],
): {
  deps: {
    adapters: Map<MeetingPlatform, MeetingPlatformAdapter>;
    createPipeline: (
      options: MeetingPipelineOptions,
    ) => MeetingPipelineInstance;
    createBillingSession?: MeetingServiceDependencies["createBillingSession"];
  };
  pipelines: ScriptedPipeline[];
} {
  const pipelines: ScriptedPipeline[] = [];
  return {
    deps: {
      adapters: new Map(adapters.map((a) => [a.platform, a])),
      createPipeline: () => {
        const pipeline = new ScriptedPipeline();
        pipelines.push(pipeline);
        return pipeline;
      },
      ...(billingSessions.length > 0
        ? {
            createBillingSession: () => {
              const billing = billingSessions.shift();
              if (!billing) {
                throw new Error("[scriptedDeps] no billing session queued");
              }
              return billing;
            },
          }
        : {}),
    },
    pipelines,
  };
}

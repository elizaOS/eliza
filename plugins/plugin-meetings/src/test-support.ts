/**
 * Test seams for the meetings orchestration layer: an in-memory runtime stub
 * that implements the exact runtime surface the service/writer/routes use
 * (memories partition, world/room/entity upserts, service lookup), a scripted
 * pipeline, and a scriptable platform adapter. Used by the vitest suites; not
 * exported from the package root.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type {
  MeetingEndReason,
  MeetingParticipant,
  MeetingPlatform,
  MeetingSessionStatus,
} from "@elizaos/shared";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import type { MeetingPipelineInstance } from "./service.js";
import type {
  MeetingBotSession,
  MeetingPipelineOptions,
  MeetingPlatformAdapter,
  PipelineTranscriptUpdate,
} from "./types.js";

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

/** One-line factory: pipeline + deps for a MeetingService under test. */
export function scriptedDeps(adapters: MeetingPlatformAdapter[]): {
  deps: {
    adapters: Map<MeetingPlatform, MeetingPlatformAdapter>;
    createPipeline: (
      options: MeetingPipelineOptions,
    ) => MeetingPipelineInstance;
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
    },
    pipelines,
  };
}

import crypto from "node:crypto";
import { DatabaseSync } from "@elizaos/agent/test-utils/sqlite-compat";
import type { AgentRuntime, Content, State, Task, UUID } from "@elizaos/core";

type SqlQuery = {
  queryChunks?: Array<{ value?: unknown }>;
};

export type LifeOpsChatTurnResult = {
  actions?: string[] | string;
  data?: Record<string, unknown>;
  text: string;
};

export type LifeOpsChatTurnHandler = (args: {
  message: Record<string, unknown>;
  messageOptions?: {
    onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
  };
  onResponse: (content: Content) => Promise<object[]>;
  runtime: AgentRuntime;
  state: State;
}) => Promise<LifeOpsChatTurnResult>;

function extractSqlText(query: SqlQuery): string {
  if (!Array.isArray(query.queryChunks)) return "";
  return query.queryChunks
    .map((chunk) => {
      const value = chunk?.value;
      if (Array.isArray(value)) return value.join("");
      return String(value ?? "");
    })
    .join("");
}

function buildRecentMessagesTranscript(
  runtime: AgentRuntime,
  memories: Array<Record<string, unknown>>,
): string {
  return memories
    .flatMap((memory) => {
      if (!memory || typeof memory !== "object") {
        return [];
      }
      const content =
        "content" in memory &&
        memory.content &&
        typeof memory.content === "object"
          ? (memory.content as Record<string, unknown>)
          : null;
      const text = typeof content?.text === "string" ? content.text.trim() : "";
      if (!text) {
        return [];
      }
      const role = memory.entityId === runtime.agentId ? "assistant" : "user";
      return [`${role}: ${text}`];
    })
    .join("\n");
}

export function createLifeOpsChatTestRuntime(options: {
  actions?: AgentRuntime["actions"];
  agentId: string;
  characterName?: string;
  handleTurn: LifeOpsChatTurnHandler;
  logger?: AgentRuntime["logger"];
  useModel: AgentRuntime["useModel"];
}): AgentRuntime {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS life_browser_settings (
      agent_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      tracking_mode TEXT NOT NULL DEFAULT 'current_tab',
      allow_browser_control INTEGER NOT NULL DEFAULT 0,
      require_confirmation_for_account_affecting INTEGER NOT NULL DEFAULT 1,
      incognito_enabled INTEGER NOT NULL DEFAULT 0,
      site_access_mode TEXT NOT NULL DEFAULT 'current_site_only',
      granted_origins_json TEXT NOT NULL DEFAULT '[]',
      blocked_origins_json TEXT NOT NULL DEFAULT '[]',
      max_remembered_tabs INTEGER NOT NULL DEFAULT 10,
      pause_until TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  let tasks: Task[] = [];
  const memoriesByRoom = new Map<string, Array<Record<string, unknown>>>();
  const roomsById = new Map<string, { id: UUID; worldId: UUID }>();
  const worldsById = new Map<
    string,
    { id: UUID; metadata?: Record<string, unknown> | null }
  >();

  const runtimeSubset = {
    agentId: options.agentId,
    actions: options.actions ?? [],
    character: {
      name: options.characterName ?? "Chen",
      postExamples: ["Sure."],
    } as AgentRuntime["character"],
    logger:
      options.logger ??
      ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as AgentRuntime["logger"]),
    useModel: options.useModel,
    getSetting: () => undefined,
    getService: () => null,
    getRoomsByWorld: async () => [],
    getRoom: async (roomId: UUID) => roomsById.get(String(roomId)) ?? null,
    getWorld: async (worldId: UUID) => worldsById.get(String(worldId)) ?? null,
    updateWorld: async (world: {
      id: UUID;
      metadata?: Record<string, unknown>;
    }) => {
      worldsById.set(String(world.id), world);
    },
    ensureConnection: async (args: {
      roomId: UUID;
      worldId: UUID;
      metadata?: Record<string, unknown>;
    }) => {
      roomsById.set(String(args.roomId), {
        id: args.roomId,
        worldId: args.worldId,
      });
      if (!worldsById.has(String(args.worldId))) {
        worldsById.set(String(args.worldId), {
          id: args.worldId,
          metadata: args.metadata ?? {},
        });
      }
    },
    createMemory: async (memory: Record<string, unknown>) => {
      const roomId = String(memory.roomId ?? "");
      if (!roomId) return;
      const current = memoriesByRoom.get(roomId) ?? [];
      current.push({
        ...memory,
        createdAt:
          typeof memory.createdAt === "number" ? memory.createdAt : Date.now(),
      });
      memoriesByRoom.set(roomId, current);
    },
    getMemories: async (query: { roomId?: string; count?: number }) => {
      const roomId = String(query.roomId ?? "");
      const current = memoriesByRoom.get(roomId) ?? [];
      const count = Math.max(1, query.count ?? current.length);
      return current.slice(-count) as Awaited<
        ReturnType<AgentRuntime["getMemories"]>
      >;
    },
    getMemoriesByRoomIds: async (query: {
      roomIds?: string[];
      limit?: number;
    }) => {
      const roomIds = Array.isArray(query.roomIds) ? query.roomIds : [];
      const merged: Array<Record<string, unknown>> = [];
      for (const roomId of roomIds) {
        merged.push(...(memoriesByRoom.get(String(roomId)) ?? []));
      }
      merged.sort(
        (left, right) =>
          Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0),
      );
      return merged.slice(-(query.limit ?? merged.length)) as Awaited<
        ReturnType<AgentRuntime["getMemoriesByRoomIds"]>
      >;
    },
    getTasks: async (query?: { tags?: string[] }) => {
      if (!query?.tags || query.tags.length === 0) return tasks;
      return tasks.filter((task) =>
        query.tags?.every((tag) => task.tags?.includes(tag)),
      );
    },
    getTask: async (taskId: UUID) =>
      tasks.find((task) => task.id === taskId) ?? null,
    createTask: async (task: Task) => {
      const id = (task.id as UUID | undefined) ?? (crypto.randomUUID() as UUID);
      tasks.push({ ...task, id });
      return id;
    },
    updateTask: async (taskId: UUID, update: Partial<Task>) => {
      tasks = tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...update,
              metadata: {
                ...((task.metadata as Record<string, unknown> | undefined) ??
                  {}),
                ...((update.metadata as Record<string, unknown> | undefined) ??
                  {}),
              } as Task["metadata"],
            }
          : task,
      );
    },
    deleteTask: async (taskId: UUID) => {
      tasks = tasks.filter((task) => task.id !== taskId);
    },
    adapter: {
      db: {
        execute: async (query: SqlQuery) => {
          const sql = extractSqlText(query).trim();
          if (sql.length === 0) return [];
          if (/^(select|pragma)\b/i.test(sql)) {
            return sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
          }
          sqlite.exec(sql);
          return [];
        },
      },
    },
  };

  const runtime = runtimeSubset as unknown as AgentRuntime;
  runtime.messageService = {
    handleMessage: async (
      runtimeArg: AgentRuntime,
      message: Record<string, unknown>,
      onResponse: (content: Content) => Promise<object[]>,
      messageOptions?: {
        onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
      },
    ) => {
      const roomId = message.roomId as UUID;
      const memories = (await runtimeArg.getMemories({
        roomId: String(roomId),
        count: 20,
      })) as Array<Record<string, unknown>>;
      const recentMessages = buildRecentMessagesTranscript(
        runtimeArg,
        memories,
      );
      const baseContent =
        message.content && typeof message.content === "object"
          ? (message.content as Record<string, unknown>)
          : {};
      const enrichedMessage = {
        ...message,
        content: {
          ...baseContent,
          source:
            typeof baseContent.source === "string"
              ? baseContent.source
              : "discord",
        },
      };
      const state: State = {
        values: {
          agentName: runtimeArg.character.name ?? "Agent",
          recentMessages,
        },
        data: {
          providers: {
            RECENT_MESSAGES: {
              data: { recentMessages: memories },
              values: { recentMessages },
            },
          },
        },
        text: recentMessages,
      } as State;

      const turn = await options.handleTurn({
        runtime: runtimeArg,
        message: enrichedMessage,
        state,
        onResponse,
        messageOptions,
      });
      const responseContent: Content & Record<string, unknown> = {
        text: turn.text,
        ...(turn.actions ? { actions: turn.actions } : {}),
        ...(turn.data ? { data: turn.data, ...turn.data } : {}),
      };

      await onResponse(responseContent);

      return {
        didRespond: true,
        responseContent,
        responseMessages: [
          {
            id: crypto.randomUUID() as UUID,
            entityId: runtimeArg.agentId,
            roomId,
            createdAt: Date.now(),
            content: responseContent,
          },
        ],
      };
    },
  } as AgentRuntime["messageService"];

  return runtime;
}

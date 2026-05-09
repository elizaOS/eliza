import crypto from "node:crypto";
import { DatabaseSync } from "@elizaos/agent";
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
    CREATE TABLE IF NOT EXISTS browser_bridge_settings (
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
    CREATE TABLE IF NOT EXISTS life_connector_grants (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      identity_json TEXT NOT NULL DEFAULT '{}',
      identity_email TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      token_ref TEXT,
      mode TEXT NOT NULL DEFAULT 'oauth',
      execution_target TEXT NOT NULL DEFAULT 'local',
      source_of_truth TEXT NOT NULL DEFAULT 'local_storage',
      preferred_by_agent INTEGER NOT NULL DEFAULT 0,
      cloud_connection_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_refresh_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, provider, side, mode, identity_email)
    );
    CREATE TABLE IF NOT EXISTS life_browser_companions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_label TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      extension_version TEXT,
      connection_state TEXT NOT NULL DEFAULT 'disconnected',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      pairing_token_hash TEXT,
      pairing_token_expires_at TEXT,
      pairing_token_revoked_at TEXT,
      pending_pairing_token_hashes_json TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT,
      paired_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, browser, profile_id)
    );
    CREATE TABLE IF NOT EXISTS browser_bridge_companions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_label TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      extension_version TEXT,
      connection_state TEXT NOT NULL DEFAULT 'disconnected',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      pairing_token_hash TEXT,
      pairing_token_expires_at TEXT,
      pairing_token_revoked_at TEXT,
      pending_pairing_token_hashes_json TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT,
      paired_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, browser, profile_id)
    );
    CREATE TABLE IF NOT EXISTS life_browser_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'user_lifeops',
      subject_type TEXT NOT NULL DEFAULT 'owner',
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'owner_agent_admin',
      context_policy TEXT NOT NULL DEFAULT 'explicit_only',
      workflow_id TEXT,
      browser TEXT,
      companion_id TEXT,
      profile_id TEXT,
      window_id TEXT,
      tab_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      actions_json TEXT NOT NULL DEFAULT '[]',
      current_action_index INTEGER NOT NULL DEFAULT 0,
      awaiting_confirmation_for_action_id TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS life_workflow_browser_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'user_lifeops',
      subject_type TEXT NOT NULL DEFAULT 'owner',
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'owner_agent_admin',
      context_policy TEXT NOT NULL DEFAULT 'explicit_only',
      workflow_id TEXT,
      browser TEXT,
      companion_id TEXT,
      profile_id TEXT,
      window_id TEXT,
      tab_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      actions_json TEXT NOT NULL DEFAULT '[]',
      current_action_index INTEGER NOT NULL DEFAULT 0,
      awaiting_confirmation_for_action_id TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS life_browser_tabs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      companion_id TEXT,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      active_in_window INTEGER NOT NULL DEFAULT 0,
      focused_window INTEGER NOT NULL DEFAULT 0,
      focused_active INTEGER NOT NULL DEFAULT 0,
      incognito INTEGER NOT NULL DEFAULT 0,
      favicon_url TEXT,
      last_seen_at TEXT NOT NULL,
      last_focused_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
    );
    CREATE TABLE IF NOT EXISTS browser_bridge_tabs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      companion_id TEXT,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      active_in_window INTEGER NOT NULL DEFAULT 0,
      focused_window INTEGER NOT NULL DEFAULT 0,
      focused_active INTEGER NOT NULL DEFAULT 0,
      incognito INTEGER NOT NULL DEFAULT 0,
      favicon_url TEXT,
      last_seen_at TEXT NOT NULL,
      last_focused_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
    );
    CREATE TABLE IF NOT EXISTS life_browser_page_contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      selection_text TEXT,
      main_text TEXT,
      headings_json TEXT NOT NULL DEFAULT '[]',
      links_json TEXT NOT NULL DEFAULT '[]',
      forms_json TEXT NOT NULL DEFAULT '[]',
      captured_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
    );
    CREATE TABLE IF NOT EXISTS browser_bridge_page_contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      selection_text TEXT,
      main_text TEXT,
      headings_json TEXT NOT NULL DEFAULT '[]',
      links_json TEXT NOT NULL DEFAULT '[]',
      forms_json TEXT NOT NULL DEFAULT '[]',
      captured_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
    );
    CREATE TABLE IF NOT EXISTS life_screen_time_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      identifier TEXT NOT NULL,
      display_name TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS life_screen_time_daily (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      identifier TEXT NOT NULL,
      date TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, source, identifier, date)
    );
    CREATE TABLE IF NOT EXISTS life_audit_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      inputs_json TEXT NOT NULL DEFAULT '{}',
      decision_json TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS life_subscription_audits (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'gmail',
      query_window_days INTEGER NOT NULL DEFAULT 180,
      status TEXT NOT NULL DEFAULT 'completed',
      total_candidates INTEGER NOT NULL DEFAULT 0,
      active_candidates INTEGER NOT NULL DEFAULT 0,
      canceled_candidates INTEGER NOT NULL DEFAULT 0,
      uncertain_candidates INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS life_subscription_candidates (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      audit_id TEXT NOT NULL,
      service_slug TEXT NOT NULL,
      service_name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'unknown',
      cadence TEXT NOT NULL DEFAULT 'unknown',
      state TEXT NOT NULL DEFAULT 'uncertain',
      confidence REAL NOT NULL DEFAULT 0,
      annual_cost_estimate_usd REAL,
      management_url TEXT,
      latest_evidence_at TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, audit_id, service_slug)
    );
    CREATE TABLE IF NOT EXISTS life_subscription_cancellations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      audit_id TEXT,
      candidate_id TEXT,
      service_slug TEXT NOT NULL,
      service_name TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'agent_browser',
      status TEXT NOT NULL DEFAULT 'draft',
      confirmed INTEGER NOT NULL DEFAULT 0,
      current_step TEXT,
      browser_session_id TEXT,
      evidence_summary TEXT,
      artifact_count INTEGER NOT NULL DEFAULT 0,
      management_url TEXT,
      error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS life_block_rules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      websites TEXT NOT NULL,
      gate_type TEXT NOT NULL,
      gate_todo_id TEXT,
      gate_until_ms INTEGER,
      fixed_duration_ms INTEGER,
      unlock_duration_ms INTEGER,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      released_at INTEGER,
      released_reason TEXT
    );
  `);
  let tasks: Task[] = [];
  const settings = new Map<string, string>();
  const cache = new Map<string, unknown>();
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
      name: options.characterName ?? "Eliza",
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
    getSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: string) => {
      settings.set(key, value);
    },
    getCache: async <T>(key: string) => cache.get(key) as T | undefined,
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    deleteCache: async (key: string) => {
      cache.delete(key);
    },
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
          const sqliteAlterAddColumn = sql.match(
            /^ALTER TABLE\s+(\S+)\s+ADD COLUMN IF NOT EXISTS\s+(.+)$/i,
          );
          if (sqliteAlterAddColumn) {
            try {
              sqlite.exec(
                `ALTER TABLE ${sqliteAlterAddColumn[1]} ADD COLUMN ${sqliteAlterAddColumn[2]}`,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              if (!/duplicate column name/i.test(message)) {
                throw error;
              }
            }
            return [];
          }
          sqlite.exec(sql);
          return [];
        },
      },
    },
  };

  const runtime = runtimeSubset as AgentRuntime;
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

/**
 * Minimal local types for the migration tool.
 *
 * These mirror the relevant subset of the Eliza `@elizaos/core` /
 * `@elizaos/agent` types WITHOUT importing those packages, so the CLI stays
 * decoupled from the agent runtime (and from its source-condition typecheck
 * quirks). The shapes are intentionally loose where the archive only needs to
 * round-trip values through `importAgent`.
 */

export type UUID = string;

/** Subset of @elizaos/core `Character` the migration produces. */
export interface MigratedCharacter {
  id?: string;
  name?: string;
  username?: string;
  system?: string;
  bio?: string[];
  adjectives?: string[];
  topics?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  messageExamples?: unknown[];
  knowledge?: Array<{ case: string; value: { text: string } }>;
  settings?: Record<string, unknown>;
}

/** Subset of @elizaos/core `Memory`. */
export interface MigratedMemory {
  id: UUID;
  entityId: UUID;
  agentId: UUID;
  roomId: UUID;
  createdAt: number;
  content: { text: string };
  metadata: { type: "custom"; source: string; tier: string };
  unique: boolean;
}

/**
 * PayloadSchema-conformant export payload (subset). Field names + nesting match
 * `@elizaos/agent`'s AgentExportPayload so `importAgent` accepts it.
 */
export interface MigratedExportPayload {
  version: number;
  exportedAt: string;
  sourceAgentId: string;
  agent: Record<string, unknown>;
  characterConfig?: Record<string, unknown>;
  entities: Array<Record<string, unknown>>;
  memories: MigratedMemory[];
  components: unknown[];
  rooms: Array<Record<string, unknown>>;
  participants: Array<{
    entityId: string;
    roomId: string;
    userState: string | null;
  }>;
  relationships: unknown[];
  worlds: Array<Record<string, unknown>>;
  tasks: unknown[];
  logs: unknown[];
}

/**
 * Deterministic unit coverage for the workerd-safe @elizaos/plugin-sql stub.
 * Drives the real module with no mocks: the exported Drizzle tables are the
 * query surface, createDatabaseAdapter and default.init throw before any
 * Worker-side adapter or runtime work, and the stub has no queue, comparator,
 * or capacity.
 */

import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import * as pluginSql from "./elizaos-plugin-sql";
import workerSqlSurface, {
  agentTable,
  cacheTable,
  channelParticipantsTable,
  channelTable,
  componentTable,
  createDatabaseAdapter,
  embeddingTable,
  entityTable,
  logTable,
  memoryTable,
  messageServerAgentsTable,
  messageServerTable,
  messageTable,
  participantTable,
  relationshipTable,
  roomTable,
  schema,
  taskTable,
  type WorkerSqlSurface,
  worldTable,
} from "./elizaos-plugin-sql";

const ADAPTER_UNAVAILABLE =
  "@elizaos/plugin-sql database adapter calls are unavailable in the Cloudflare Workers bundle. Agent DB access runs on the agent-server sidecar, not the Worker.";

const INIT_UNAVAILABLE =
  "@elizaos/plugin-sql runtime calls are unavailable in the Cloudflare Workers bundle. Server-side agent runtime calls run on the agent-server sidecar.";

const EXPORT_NAMES = [
  "agentTable",
  "cacheTable",
  "channelParticipantsTable",
  "channelTable",
  "componentTable",
  "createDatabaseAdapter",
  "default",
  "embeddingTable",
  "entityTable",
  "logTable",
  "memoryTable",
  "messageServerAgentsTable",
  "messageServerTable",
  "messageTable",
  "participantTable",
  "relationshipTable",
  "roomTable",
  "schema",
  "taskTable",
  "worldTable",
] as const;

const SCHEMA_TABLE_NAMES = [
  "agentTable",
  "roomTable",
  "participantTable",
  "memoryTable",
  "embeddingTable",
  "entityTable",
  "relationshipTable",
  "componentTable",
  "taskTable",
  "logTable",
  "cacheTable",
  "worldTable",
  "messageServerAgentsTable",
  "messageTable",
  "messageServerTable",
  "channelTable",
  "channelParticipantsTable",
] as const;

const TABLE_SQL_NAMES = {
  agentTable: "agents",
  cacheTable: "cache",
  channelParticipantsTable: "channel_participants",
  channelTable: "channels",
  componentTable: "components",
  embeddingTable: "embeddings",
  entityTable: "entities",
  logTable: "logs",
  memoryTable: "memories",
  messageServerAgentsTable: "message_server_agents",
  messageServerTable: "message_servers",
  messageTable: "central_messages",
  participantTable: "participants",
  relationshipTable: "relationships",
  roomTable: "rooms",
  taskTable: "tasks",
  worldTable: "worlds",
} as const;

type SchemaTableName = (typeof SCHEMA_TABLE_NAMES)[number];

type ColumnView = {
  name: string;
  columnType: string;
  dataType: string;
  primary: boolean;
  notNull: boolean;
  hasDefault: boolean;
};

const adapter = createDatabaseAdapter as (
  config?: { dataDir?: string; postgresUrl?: string },
  agentId?: string,
  extra?: unknown,
) => never;

const init = workerSqlSurface.init as (...args: unknown[]) => Promise<never>;

function columnsOf(table: PgTable): Record<string, ColumnView> {
  return getTableColumns(table) as Record<string, ColumnView>;
}

function columnSqlMap(table: PgTable): Record<string, string> {
  return Object.fromEntries(
    Object.entries(columnsOf(table)).map(([key, column]) => [key, column.name]),
  );
}

function extraPrimaryKeyColumns(table: PgTable): string[][] {
  return getTableConfig(table).primaryKeys.map((primaryKey) =>
    primaryKey.columns.map((column) => column.name),
  );
}

const NAMED_TABLES: Record<SchemaTableName, PgTable> = {
  agentTable,
  roomTable,
  participantTable,
  memoryTable,
  embeddingTable,
  entityTable,
  relationshipTable,
  componentTable,
  taskTable,
  logTable,
  cacheTable,
  worldTable,
  messageServerAgentsTable,
  messageTable,
  messageServerTable,
  channelTable,
  channelParticipantsTable,
};

function schemaTable(name: SchemaTableName): PgTable {
  return schema[name];
}

function namedTable(name: SchemaTableName): PgTable {
  return NAMED_TABLES[name];
}

function expectUnavailable(
  fn: () => unknown,
  message: string,
  label: string,
): void {
  expect(fn).toThrowError(message);
  try {
    fn();
    throw new Error(`expected ${label} to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
  }
}

describe("elizaos-plugin-sql Worker stub", () => {
  test("exports the twenty runtime stand-ins and nothing else", () => {
    expect([...Object.keys(pluginSql)].sort()).toEqual([...EXPORT_NAMES]);
    expect(Object.keys(pluginSql)).toHaveLength(20);
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const record = pluginSql as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });

  test("schema keys are the seventeen tables in source order", () => {
    expect(Object.keys(schema)).toEqual([...SCHEMA_TABLE_NAMES]);
    expect(Object.keys(schema)).toHaveLength(17);
  });

  test("named table exports are the same objects as schema entries", () => {
    for (const name of SCHEMA_TABLE_NAMES) {
      expect(namedTable(name)).toBe(schemaTable(name));
    }
  });

  test("default export is the Worker surface wrapping the same schema", () => {
    const surface: WorkerSqlSurface = workerSqlSurface;
    expect(surface).toBe(pluginSql.default);
    expect(surface.schema).toBe(schema);
    expect(Object.keys(surface)).toEqual([
      "name",
      "description",
      "schema",
      "init",
    ]);
    expect(surface.name).toBe("@elizaos/plugin-sql");
    expect(surface.description).toBe(
      "Workers compatibility surface for @elizaos/plugin-sql — schema only; runtime calls are sidecar-only",
    );
    expect(typeof surface.init).toBe("function");
    expect(surface.init.length).toBe(0);
  });

  test("looking up a missing schema key is undefined (no remove path)", () => {
    const record = schema as unknown as Record<string, unknown>;
    expect(record.messages).toBeUndefined();
    expect(record.queue).toBeUndefined();
    expect("messages" in record).toBe(false);
    expect(record.messageTable).toBe(schema.messageTable);
  });

  describe("SQL table names", () => {
    test.each(SCHEMA_TABLE_NAMES)(
      "%s maps to the observed SQL name",
      (name) => {
        expect(getTableName(schemaTable(name))).toBe(TABLE_SQL_NAMES[name]);
      },
    );

    test("messageTable is central_messages, not messages", () => {
      expect(getTableName(schema.messageTable)).toBe("central_messages");
      expect(getTableName(schema.messageTable)).not.toBe("messages");
    });
  });

  describe("column maps that historically drifted", () => {
    test("rooms uses message_server_id and has no server_id column", () => {
      const columns = columnsOf(schema.roomTable);
      expect(columnSqlMap(schema.roomTable)).toEqual({
        id: "id",
        agentId: "agent_id",
        source: "source",
        type: "type",
        messageServerId: "message_server_id",
        worldId: "world_id",
        name: "name",
        channelId: "channel_id",
        metadata: "metadata",
        createdAt: "created_at",
      });
      expect(columns.server_id).toBeUndefined();
      expect(columns.serverId).toBeUndefined();
      expect(columns.messageServerId.primary).toBe(false);
      expect(columns.id.primary).toBe(true);
    });

    test("agents keeps the snake_case server_id property plus system and settings", () => {
      const columns = columnsOf(schema.agentTable);
      expect(columns.server_id.name).toBe("server_id");
      expect(columns.system.name).toBe("system");
      expect(columns.settings.name).toBe("settings");
      expect(columns.serverId).toBeUndefined();
      expect(columns.id.primary).toBe(true);
      expect(columns.enabled.columnType).toBe("PgBoolean");
      expect(columns.enabled.hasDefault).toBe(true);
      expect(columns.bio.columnType).toBe("PgJsonb");
    });

    test("cache uses key as the primary key and has no id column", () => {
      const columns = columnsOf(schema.cacheTable);
      expect(columnSqlMap(schema.cacheTable)).toEqual({
        key: "key",
        agentId: "agent_id",
        value: "value",
        createdAt: "created_at",
        expiresAt: "expires_at",
      });
      expect(columns.key.primary).toBe(true);
      expect(columns.id).toBeUndefined();
      expect(extraPrimaryKeyColumns(schema.cacheTable)).toEqual([]);
    });

    test("message_server_agents is a composite-primary-key join table", () => {
      const columns = columnsOf(schema.messageServerAgentsTable);
      expect(columnSqlMap(schema.messageServerAgentsTable)).toEqual({
        messageServerId: "message_server_id",
        agentId: "agent_id",
      });
      expect(columns.messageServerId.primary).toBe(false);
      expect(columns.agentId.primary).toBe(false);
      expect(columns.messageServerId.notNull).toBe(true);
      expect(columns.agentId.notNull).toBe(true);
      expect(extraPrimaryKeyColumns(schema.messageServerAgentsTable)).toEqual([
        ["message_server_id", "agent_id"],
      ]);
    });

    test("channel_participants has two nullable columns and no primary key", () => {
      const columns = columnsOf(schema.channelParticipantsTable);
      expect(columnSqlMap(schema.channelParticipantsTable)).toEqual({
        channelId: "channel_id",
        entityId: "entity_id",
      });
      expect(columns.channelId.primary).toBe(false);
      expect(columns.entityId.primary).toBe(false);
      expect(columns.channelId.notNull).toBe(false);
      expect(columns.entityId.notNull).toBe(false);
      expect(extraPrimaryKeyColumns(schema.channelParticipantsTable)).toEqual(
        [],
      );
    });

    test("tasks.tags is a text array; relationships.tags is jsonb", () => {
      const taskTags = columnsOf(schema.taskTable).tags;
      const relationshipTags = columnsOf(schema.relationshipTable).tags;
      expect(taskTags.name).toBe("tags");
      expect(taskTags.columnType).toBe("PgArray");
      expect(taskTags.dataType).toBe("array");
      expect(relationshipTags.name).toBe("tags");
      expect(relationshipTags.columnType).toBe("PgJsonb");
      expect(relationshipTags.dataType).toBe("json");
    });

    test("memories.unique is a boolean with a default, not a unique constraint field", () => {
      const unique = columnsOf(schema.memoryTable).unique;
      expect(unique.name).toBe("unique");
      expect(unique.columnType).toBe("PgBoolean");
      expect(unique.hasDefault).toBe(true);
      expect(unique.primary).toBe(false);
    });
  });

  describe("createDatabaseAdapter", () => {
    test("is a two-argument function that throws the unavailable Error", () => {
      expect(typeof createDatabaseAdapter).toBe("function");
      expect(createDatabaseAdapter.length).toBe(2);
      expectUnavailable(
        () => adapter({ dataDir: "/tmp" }, "agent-1"),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter",
      );
    });

    test("throws the same Error for an empty config object (no comparator branch)", () => {
      expectUnavailable(
        () => adapter({}, "agent-1"),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter empty config",
      );
    });

    test("throws the same Error when both config fields are present", () => {
      expectUnavailable(
        () =>
          adapter(
            {
              dataDir: "/tmp/eliza",
              postgresUrl: "postgres://localhost/eliza",
            },
            "agent-1",
          ),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter populated config",
      );
    });

    test("throws the same Error with no arguments (empty call)", () => {
      expectUnavailable(
        () => adapter(),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter no arguments",
      );
    });

    test("throws the same Error for a single argument (no single-element success path)", () => {
      expectUnavailable(
        () => adapter({ postgresUrl: "postgres://localhost/eliza" }),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter single argument",
      );
    });

    test("throws the same Error when extra overflow arguments are supplied", () => {
      expectUnavailable(
        () => adapter({}, "agent-1", { overflow: true }),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter overflow",
      );
    });

    test("keeps throwing on repeated calls (no capacity or unlock after a miss)", () => {
      expectUnavailable(
        () => adapter({}, "missing-agent"),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter first miss",
      );
      expectUnavailable(
        () => adapter({}, "missing-agent"),
        ADAPTER_UNAVAILABLE,
        "createDatabaseAdapter repeated miss",
      );
    });
  });

  describe("default.init", () => {
    test("rejects with the unavailable Error", async () => {
      await expect(init()).rejects.toThrowError(INIT_UNAVAILABLE);
      await expect(init()).rejects.toBeInstanceOf(Error);
      try {
        await init();
        throw new Error("expected init to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(INIT_UNAVAILABLE);
      }
    });

    test("rejects the same way with extra overflow arguments", async () => {
      await expect(init("overflow")).rejects.toThrowError(INIT_UNAVAILABLE);
    });

    test("keeps rejecting on repeated calls (no unlock)", async () => {
      await expect(init()).rejects.toThrowError(INIT_UNAVAILABLE);
      await expect(init()).rejects.toThrowError(INIT_UNAVAILABLE);
    });
  });
});

/** Proves the real copy loop preserves raw phone JSON through SQL and R2 boundaries. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import pg from "pg";
import type { RuntimeR2Bucket } from "../../shared/src/lib/storage/r2-runtime-binding";
import { setRuntimeR2Bucket } from "../../shared/src/lib/storage/r2-runtime-binding";
import type { CliArgs, PgClient } from "./migrate-database";

mock.module("./local-dev-helpers", () => ({ loadEnvFiles: mock() }));

const { copyTable } = await import("./migrate-database");

const ORGANIZATION_ID = "51111111-1111-4111-8111-111111111111";
const PHONE_NUMBER_ID = "52222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "53333333-3333-4333-8333-333333333333";
const CREATED_AT = new Date("2026-08-20T12:34:56.000Z");
const RAW_METADATA = '{"huge":1e400,"tiny":1e-400,"nested":{"value":9e999}}';
const LEGACY_MEDIA_KEY = `phone-message-payloads/${ORGANIZATION_ID}/2026-08-20/${MESSAGE_ID}/media_urls.txt`;
const LEGACY_METADATA_KEY = `phone-message-payloads/${ORGANIZATION_ID}/2026-08-20/${MESSAGE_ID}/metadata.txt`;
const storageEnv = process.env as Record<string, string | undefined>;
const STORAGE_ENV_KEYS = [
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;
const originalStorageEnv = Object.fromEntries(
  STORAGE_ENV_KEYS.map((key) => [key, storageEnv[key]]),
);

function configureStorageEnv(): void {
  storageEnv.STORAGE_PROVIDER = "s3";
  storageEnv.STORAGE_ENDPOINT = "https://storage.example.test";
  storageEnv.STORAGE_REGION = "test";
  storageEnv.STORAGE_ACCESS_KEY_ID = "test-access";
  storageEnv.STORAGE_SECRET_ACCESS_KEY = "test-secret";
}

const sourceColumns = [
  ["id", "uuid"],
  ["phone_number_id", "uuid"],
  ["direction", "text"],
  ["from_number", "text"],
  ["to_number", "text"],
  ["message_body", "text"],
  ["message_body_storage", "text"],
  ["message_body_key", "text"],
  ["media_urls", "text"],
  ["media_urls_storage", "text"],
  ["media_urls_key", "text"],
  ["agent_response", "text"],
  ["agent_response_storage", "text"],
  ["agent_response_key", "text"],
  ["metadata", "text"],
  ["metadata_storage", "text"],
  ["metadata_key", "text"],
  ["created_at", "timestamp without time zone"],
] as const;

const destinationColumns = [
  ...sourceColumns.map(([name, dataType]) => ({
    column_name: name,
    data_type:
      name === "media_urls" || name === "metadata" ? "jsonb" : dataType,
    is_generated: "NEVER",
  })),
  {
    column_name: "organization_id",
    data_type: "uuid",
    is_generated: "NEVER",
  },
];

const sourceRow: Record<string, unknown> = {
  id: MESSAGE_ID,
  phone_number_id: PHONE_NUMBER_ID,
  direction: "inbound",
  from_number: "+14155550100",
  to_number: "+14155550101",
  message_body: `body-${"b".repeat(64)}`,
  message_body_storage: "inline",
  message_body_key: null,
  media_urls: '["https://media.example.test/oversized"]',
  media_urls_storage: "inline",
  media_urls_key: null,
  agent_response: `response-${"r".repeat(64)}`,
  agent_response_storage: "inline",
  agent_response_key: null,
  metadata: RAW_METADATA,
  metadata_storage: "inline",
  metadata_key: null,
  created_at: CREATED_AT,
  __phone_message_owner_organization_id: ORGANIZATION_ID,
};

function result(rows: unknown[]): { rows: unknown[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}

function sourceClient(
  row: Record<string, unknown> = sourceRow,
  columns: ReadonlyArray<readonly [string, string]> = sourceColumns,
): PgClient {
  return {
    query: mock(async (sql: string, params?: unknown[]) => {
      if (sql.includes("information_schema.columns")) {
        return result(
          columns.map(([name, dataType]) => ({
            column_name: name,
            data_type: dataType,
            is_generated: "NEVER",
          })),
        );
      }
      if (sql.includes("FROM pg_index")) return result([{ column_name: "id" }]);
      if (sql.includes("count(*)::text")) return result([{ c: "1" }]);
      if (sql.includes('FROM public."phone_message_log"')) {
        return result(params && params.length > 1 ? [] : [row]);
      }
      throw new Error(`Unexpected source query: ${sql}`);
    }),
  } as unknown as PgClient;
}

function destinationClient(columns = destinationColumns): {
  client: PgClient;
  inserts: Array<{ sql: string; values: unknown[] }>;
  queries: string[];
} {
  const inserts: Array<{ sql: string; values: unknown[] }> = [];
  const queries: string[] = [];
  const client = {
    query: mock(async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.includes("information_schema.columns")) return result(columns);
      if (sql.includes("FROM pg_index")) return result([{ column_name: "id" }]);
      if (sql.includes('FROM "_migration_state"')) return result([]);
      if (sql.startsWith('INSERT INTO public."phone_message_log"')) {
        inserts.push({ sql, values: values ?? [] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as PgClient;
  return { client, inserts, queries };
}

function args(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    dryRun: false,
    noR2: true,
    reset: false,
    skipMigrate: true,
    skipRedis: true,
    batchSize: 10,
    r2MinBytes: 1,
    only: null,
    skip: new Set(),
    ...overrides,
  };
}

afterEach(() => {
  setRuntimeR2Bucket(null);
  for (const key of STORAGE_ENV_KEYS) {
    const original = originalStorageEnv[key];
    if (original === undefined) delete storageEnv[key];
    else storageEnv[key] = original;
  }
});

describe("migrate-database phone copy loop", () => {
  test("binds timezone-less source timestamps back to PostgreSQL as UTC", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Paris";
    try {
      const pgWithUtils = pg as typeof pg & {
        utils: { prepareValue(value: unknown): unknown };
      };
      expect(pg.defaults.parseInputDatesAsUTC).toBe(true);
      expect(
        pgWithUtils.utils.prepareValue(new Date("2026-08-20T23:30:00.000Z")),
      ).toBe("2026-08-20T23:30:00.000+00:00");
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  test("does not treat a lookalike non-phone JSONB value as an internal raw parameter", async () => {
    const table = "non_phone_json_values";
    const columns = [
      { column_name: "id", data_type: "uuid", is_generated: "NEVER" },
      { column_name: "payload", data_type: "jsonb", is_generated: "NEVER" },
    ];
    const collision = {
      kind: "raw-json-parameter",
      raw: "null",
      parsed: "legitimate application data",
      keep: "must-survive",
    };
    const row = { id: MESSAGE_ID, payload: collision };
    const source = {
      query: mock(async (sql: string, params?: unknown[]) => {
        if (sql.includes("information_schema.columns")) return result(columns);
        if (sql.includes("FROM pg_index"))
          return result([{ column_name: "id" }]);
        if (sql.includes("count(*)::text")) return result([{ c: "1" }]);
        if (sql.includes(`FROM public."${table}"`))
          return result(params && params.length > 1 ? [] : [row]);
        throw new Error(`Unexpected source query: ${sql}`);
      }),
    } as unknown as PgClient;
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const destination = {
      query: mock(async (sql: string, values?: unknown[]) => {
        if (sql.includes("information_schema.columns")) return result(columns);
        if (sql.includes("FROM pg_index"))
          return result([{ column_name: "id" }]);
        if (sql.includes('FROM "_migration_state"')) return result([]);
        if (sql.startsWith(`INSERT INTO public."${table}"`)) {
          inserts.push({ sql, values: values ?? [] });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as PgClient;

    await copyTable(source, destination, table, args());

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.sql).toContain("$2::jsonb");
    expect(inserts[0]?.values[1]).toBe(JSON.stringify(collision));
  });

  test("binds exact source lexemes as jsonb without JavaScript reserialization", async () => {
    const destination = destinationClient();
    await copyTable(
      sourceClient(),
      destination.client,
      "phone_message_log",
      args(),
    );

    expect(destination.inserts).toHaveLength(1);
    const insert = destination.inserts[0];
    if (!insert) throw new Error("Expected one destination insert");
    const metadataIndex = sourceColumns.findIndex(
      ([name]) => name === "metadata",
    );
    const mediaIndex = sourceColumns.findIndex(
      ([name]) => name === "media_urls",
    );
    expect(insert.sql).toContain(`$${metadataIndex + 1}::jsonb`);
    expect(insert.sql).toContain(`$${mediaIndex + 1}::jsonb`);
    expect(insert.values[metadataIndex]).toBe(RAW_METADATA);
    expect(insert.values[mediaIndex]).toBe(sourceRow.media_urls);
    expect(insert.sql).toContain('"organization_id"');
    expect(insert.values.at(-1)).toBe(ORGANIZATION_ID);
  });

  test("rejects a modern message whose immutable tenant differs from its phone owner", async () => {
    const modernSourceColumns = [
      ...sourceColumns,
      ["organization_id", "uuid"] as const,
    ];
    const destination = destinationClient();

    await expect(
      copyTable(
        sourceClient(
          {
            ...sourceRow,
            organization_id: ORGANIZATION_ID,
            __phone_message_owner_organization_id:
              "54444444-4444-4444-8444-444444444444",
          },
          modernSourceColumns,
        ),
        destination.client,
        "phone_message_log",
        args(),
      ),
    ).rejects.toMatchObject({
      code: "PHONE_MIGRATION_POINTER_INVALID",
      context: {
        table: "phone_message_log",
        rule: "tenant_owner_mismatch",
      },
    });
    expect(destination.inserts).toHaveLength(0);
    expect(destination.queries).not.toContain("BEGIN");
  });

  test("rejects a JSON null lexeme before any SQL or object-store write", async () => {
    let puts = 0;
    setRuntimeR2Bucket({
      async get() {
        return null;
      },
      async put() {
        puts += 1;
        return {};
      },
      async delete() {
        return {};
      },
    });
    configureStorageEnv();
    const destination = destinationClient();

    await expect(
      copyTable(
        sourceClient({ ...sourceRow, metadata: " \n null\t" }),
        destination.client,
        "phone_message_log",
        args({ noR2: false }),
      ),
    ).rejects.toMatchObject({
      code: "PHONE_MIGRATION_JSON_INVALID",
      context: {
        table: "phone_message_log",
        column: "metadata",
        rule: "json_null",
      },
    });
    expect(puts).toBe(0);
    expect(destination.inserts).toHaveLength(0);
    expect(destination.queries).not.toContain("BEGIN");
  });

  test("dry-run validates phone JSON before a legacy TEXT destination is migrated", async () => {
    const legacyDestination = destinationClient(
      sourceColumns.map(([name, dataType]) => ({
        column_name: name,
        data_type: dataType,
        is_generated: "NEVER",
      })),
    );

    const stats = await copyTable(
      sourceClient(),
      legacyDestination.client,
      "phone_message_log",
      args({ dryRun: true }),
    );

    expect(stats).toMatchObject({ source: 1, copied: 1, r2Uploads: 0 });
    expect(legacyDestination.inserts).toHaveLength(0);
    expect(legacyDestination.queries).not.toContain("BEGIN");
  });

  test("uploads the exact raw JSON lexeme before persisting immutable pointers", async () => {
    const puts: Array<{ key: string; value: string; createOnly: boolean }> = [];
    const bucket: RuntimeR2Bucket = {
      async get() {
        return null;
      },
      async put(key, value, options) {
        if (typeof value !== "string")
          throw new Error("Expected string payload");
        puts.push({ key, value, createOnly: Boolean(options?.onlyIf) });
        return {};
      },
      async delete() {
        return {};
      },
    };
    setRuntimeR2Bucket(bucket);
    configureStorageEnv();
    const destination = destinationClient();

    await copyTable(
      sourceClient(),
      destination.client,
      "phone_message_log",
      args({ noR2: false }),
    );

    expect(puts).toHaveLength(4);
    expect(puts.find(({ key }) => key.includes("/metadata."))?.value).toBe(
      RAW_METADATA,
    );
    expect(puts.every(({ createOnly }) => createOnly)).toBe(true);
    const insert = destination.inserts[0];
    if (!insert) throw new Error("Expected one destination insert");
    const metadataStorageIndex = sourceColumns.findIndex(
      ([name]) => name === "metadata_storage",
    );
    const metadataKeyIndex = sourceColumns.findIndex(
      ([name]) => name === "metadata_key",
    );
    expect(insert.values[metadataStorageIndex]).toBe("r2");
    expect(String(insert.values[metadataKeyIndex])).toContain(
      `/${ORGANIZATION_ID}/2026-08-20/${MESSAGE_ID}/metadata.`,
    );
  });

  test("preserves legacy deterministic text pointers for migrated JSON payloads", async () => {
    const destination = destinationClient();
    await copyTable(
      sourceClient({
        ...sourceRow,
        media_urls: "[]",
        media_urls_storage: "r2",
        media_urls_key: LEGACY_MEDIA_KEY,
        metadata: "{}",
        metadata_storage: "r2",
        metadata_key: LEGACY_METADATA_KEY,
      }),
      destination.client,
      "phone_message_log",
      args(),
    );

    const insert = destination.inserts[0];
    if (!insert) throw new Error("Expected one destination insert");
    const mediaKeyIndex = sourceColumns.findIndex(
      ([name]) => name === "media_urls_key",
    );
    const metadataKeyIndex = sourceColumns.findIndex(
      ([name]) => name === "metadata_key",
    );
    expect(insert.values[mediaKeyIndex]).toBe(LEGACY_MEDIA_KEY);
    expect(insert.values[metadataKeyIndex]).toBe(LEGACY_METADATA_KEY);
  });

  test("full dry-run reads rows but performs no progress, SQL, or R2 write", async () => {
    let puts = 0;
    setRuntimeR2Bucket({
      async get() {
        return null;
      },
      async put() {
        puts += 1;
        return {};
      },
      async delete() {
        return {};
      },
    });
    configureStorageEnv();
    const destination = destinationClient();

    const stats = await copyTable(
      sourceClient(),
      destination.client,
      "phone_message_log",
      args({ dryRun: true, noR2: false }),
    );

    expect(stats).toMatchObject({ source: 1, copied: 1, r2Uploads: 0 });
    expect(puts).toBe(0);
    expect(destination.inserts).toHaveLength(0);
    expect(
      destination.queries.some((sql) => sql.includes("_migration_state")),
    ).toBe(false);
    expect(
      destination.queries.some((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)),
    ).toBe(false);
  });
});

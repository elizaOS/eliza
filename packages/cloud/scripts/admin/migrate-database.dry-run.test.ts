/** Proves dry-run progress handling performs no destination state-table writes. */

import { describe, expect, mock, test } from "bun:test";
import type { PgClient } from "./migrate-database";

mock.module("./local-dev-helpers", () => ({
  loadEnvFiles: mock(),
}));

const { loadProgress, prepareProgressState } = await import(
  "./migrate-database"
);

function progressClient(query: ReturnType<typeof mock>): PgClient {
  return { query } as unknown as PgClient;
}

describe("migrate-database dry-run progress", () => {
  test("does not create, reset, read, or write _migration_state", async () => {
    const query = mock(async (_sql: string) => {
      throw new Error("dry-run must not query migration progress");
    });
    const client = progressClient(query);

    await prepareProgressState(client, { dryRun: true, reset: true });
    await expect(
      loadProgress(client, "phone_message_log", true),
    ).resolves.toEqual({
      cursor: null,
      copied: 0,
      r2Uploads: 0,
      r2Bytes: 0,
      completed: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  test("retains durable state initialization for write runs", async () => {
    const query = mock(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const client = progressClient(query);

    await prepareProgressState(client, { dryRun: false, reset: false });

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'CREATE TABLE IF NOT EXISTS "_migration_state"',
    );
  });
});

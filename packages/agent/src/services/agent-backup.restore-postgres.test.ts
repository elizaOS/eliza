/**
 * Postgres row restore runs inside one transaction. A failed statement aborts
 * that transaction, so restore must surface the statement's own error and roll
 * back instead of discarding it and failing later with an opaque "transaction
 * is aborted" error. `pg` is replaced with a client that models aborted-state
 * semantics.
 */

import { createHash } from "node:crypto";
import { AGENT_BACKUP_CANONICAL_JSON, stableJsonString } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  failWhen: null as ((sql: string) => Error | null) | null,
  tablesPresent: { embeddings: true, agents: true },
}));

vi.mock("pg", () => {
  class FakeClient {
    private aborted = false;
    async query(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      pgState.queries.push(text);
      if (text === "ROLLBACK") {
        this.aborted = false;
        return { rows: [] };
      }
      if (this.aborted) {
        throw new Error(
          "current transaction is aborted, commands ignored until end of transaction block",
        );
      }
      if (text.includes("to_regclass")) {
        return { rows: [{ ...pgState.tablesPresent }] };
      }
      const failure = pgState.failWhen?.(text) ?? null;
      if (failure) {
        this.aborted = true;
        throw failure;
      }
      return { rows: [] };
    }
    release() {}
  }
  class Pool {
    async connect() {
      return new FakeClient();
    }
    async end() {}
  }
  return { default: { Pool } };
});

import {
  type AgentBackupPostgresDump,
  restorePostgresRows,
} from "./agent-backup.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function dump(): AgentBackupPostgresDump {
  const tables = [
    {
      name: "memories",
      columns: ["id", "agent_id"],
      rows: [{ id: "m1", agent_id: AGENT_ID }],
    },
  ];
  const sha256 = createHash("sha256")
    .update(stableJsonString(tables, AGENT_BACKUP_CANONICAL_JSON))
    .digest("hex");
  return { kind: "postgres-rows", tables, sha256 };
}

beforeEach(() => {
  pgState.queries = [];
  pgState.failWhen = null;
  pgState.tablesPresent = { embeddings: true, agents: true };
});

describe("restorePostgresRows", () => {
  it("rolls back with the real error when the embeddings delete fails", async () => {
    const cause = new Error("permission denied for table embeddings");
    pgState.failWhen = (sql) =>
      sql.startsWith('DELETE FROM "embeddings"') ? cause : null;

    await expect(
      restorePostgresRows("postgres://test", AGENT_ID, dump()),
    ).rejects.toBe(cause);
    expect(pgState.queries).toContain("ROLLBACK");
    expect(pgState.queries).not.toContain("COMMIT");
    expect(pgState.queries.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("rolls back with the real error when the agent-row delete fails", async () => {
    const cause = new Error(
      'update or delete on table "agents" violates foreign key constraint',
    );
    pgState.failWhen = (sql) =>
      sql.startsWith('DELETE FROM "agents"') ? cause : null;

    await expect(
      restorePostgresRows("postgres://test", AGENT_ID, dump()),
    ).rejects.toBe(cause);
    expect(pgState.queries).toContain("ROLLBACK");
    expect(pgState.queries).not.toContain("COMMIT");
  });

  it("skips deletes for tables that do not exist and commits", async () => {
    pgState.tablesPresent = { embeddings: false, agents: false };

    await restorePostgresRows("postgres://test", AGENT_ID, dump());
    expect(
      pgState.queries.some((sql) => sql.startsWith('DELETE FROM "embeddings"')),
    ).toBe(false);
    expect(
      pgState.queries.some((sql) => sql.startsWith('DELETE FROM "agents"')),
    ).toBe(false);
    expect(pgState.queries).toContain(
      'DELETE FROM "memories" WHERE "agent_id" = $1',
    );
    expect(pgState.queries.at(-1)).toBe("COMMIT");
  });
});

// Exercises cloud DB agent sandboxes behavior with deterministic repository fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let capturedWhere: SQL | undefined;

const returning = mock(() => [
  {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    status: "provisioning",
  },
]);
const where = mock((clause: SQL) => {
  capturedWhere = clause;
  return { returning };
});
// Read the captured update payload back from `set.mock.calls` rather than a
// side-channel `let`: a `let` reassigned only inside this closure gets narrowed
// to `undefined` by tsgo (it doesn't apply tsc's closure-reassignment widening),
// turning `?.status` into a property access on `never`. `mock.calls` carries the
// argument type verbatim, so the read below stays `Record<string, unknown>`.
const set = mock((values: Record<string, unknown>) => {
  void values;
  return { where };
});
const update = mock(() => ({ set }));
const ensureAgentSandboxSchema = mock(async () => {});

// Read-side select() chain: select(...).from(...).where(clause) -> rows.
// `where` captures the clause into the shared `capturedWhere` so a test can
// assert on the generated SQL, mirroring the write-side capture above.
let selectRows: unknown[] = [];

function chainableRows(): unknown[] & {
  limit: () => unknown[];
  orderBy: () => unknown[] & { limit: () => unknown[]; orderBy: () => unknown[] };
} {
  const rows = [...selectRows] as unknown[] & {
    limit: () => unknown[];
    orderBy: () => unknown[] & { limit: () => unknown[]; orderBy: () => unknown[] };
  };
  rows.limit = () => rows;
  rows.orderBy = () => rows;
  return rows;
}

const selectWhere = mock((clause: SQL) => {
  capturedWhere = clause;
  // Most readers await the where() result directly (an array). Queries that
  // paginate or sort chain `.limit(n)` / `.orderBy(...)` after `where()`;
  // expose those methods so all shapes resolve to the configured rows.
  return chainableRows();
});
const selectFrom = mock(() => ({ where: selectWhere }));
const select = mock(() => ({ from: selectFrom }));

mock.module("../helpers", () => ({
  dbRead: { select },
  dbWrite: { update },
}));

mock.module("../ensure-agent-sandbox-schema", () => ({
  ensureAgentSandboxSchema,
}));

describe("AgentSandboxesRepository", () => {
  beforeEach(() => {
    selectRows = [];
  });

  test("allows sleeping agents to take the provisioning lock for wake", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().trySetProvisioning("e06bb509-6c52-4c33-a9f7-66addc43e8c8");

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere) throw new Error("trySetProvisioning did not build a where clause");
    expect(new PgDialect().sqlToQuery(capturedWhere).sql).toContain("'sleeping'");
  });

  test("provisioning lock admits a running row ONLY when it has no container (re-provision unblock)", async () => {
    // Bug: a direct/shared provision inserts the row as `running` BEFORE any
    // container exists. If that provision crashes, the row is stuck at
    // `running` with NO container, and the old `status IN (...)` clause (which
    // excludes `running`) could never retake the lock — blocking re-provision
    // PERMANENTLY (the tonight outage; an engineer had to reset rows to
    // `pending` by hand). The fix admits `running` too, but ONLY for a
    // never-containerized row.
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().trySetProvisioning("e06bb509-6c52-4c33-a9f7-66addc43e8c8");

    if (!capturedWhere) throw new Error("trySetProvisioning did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();

    // The existing acquirable states still work (regression guard)...
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'provisioning'");
    expect(sql).toContain("'stopped'");
    expect(sql).toContain("'sleeping'");
    expect(sql).toContain("'disconnected'");
    expect(sql).toContain("'error'");

    // ...AND a `running` row can now be acquired...
    expect(sql).toContain("'running'");

    // ...but the `running` branch is GATED on BOTH container fields being NULL.
    // This is the live-agent protection (load-bearing): the moment a container
    // is created the provision path stamps container_name / sandbox_id, so a
    // genuinely-running dedicated agent can NEVER satisfy this branch and can
    // NEVER have its lock taken or be double-provisioned. Assert both NULL
    // guards are present on the running branch.
    expect(sql).toContain("container_name");
    expect(sql).toContain("sandbox_id");
    // The running admission must be an OR alternative to the IN-list, not a
    // standalone clause that would widen acquisition.
    expect(sql).toContain(" or ");

    // Structural fence: everything from the `'running'` literal onward must
    // reference BOTH container columns AND carry two `is null` predicates —
    // i.e. the running admission is gated by container_name IS NULL *and*
    // sandbox_id IS NULL, never just one (a running-WITH-container row can
    // never match). Pin the positional shape so a future edit can't loosen the
    // guard to a single column.
    const i = sql.indexOf("'running'");
    expect(i).toBeGreaterThan(-1);
    const after = sql.slice(i);
    expect(after).toContain("container_name");
    expect(after).toContain("sandbox_id");
    expect((after.match(/is null/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("heartbeat selection excludes shared-runtime agents (no container to dial)", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().listRunning();

    if (!capturedWhere) throw new Error("listRunning did not build a where clause");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    const sql = query.sql.toLowerCase();
    // Only running rows are heartbeated...
    expect(sql).toContain("status");
    // ...and shared-tier rows are filtered out: they run container-free in the
    // hosted shared runtime, so dialing them over Headscale always fails. The
    // `<>` keeps that exclusion (NOT just `= 'shared'`).
    expect(sql).toContain("execution_tier");
    expect(sql).toContain("<>");
    // eq/ne bind their operands, so the values land in `params`, not the SQL.
    expect(query.params).toContain("running");
    expect(query.params).toContain("shared");
  });

  test("marks only orphaned user-owned pending rows with no provision job as error", async () => {
    capturedWhere = undefined;
    set.mockClear();

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    const cutoff = new Date("2026-06-14T00:00:00.000Z");
    await new AgentSandboxesRepository().markOrphanedPendingWithoutJobAsError(cutoff);

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere)
      throw new Error("markOrphanedPendingWithoutJobAsError did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    // Only `pending` rows are targeted...
    expect(sql).toContain("'pending'");
    // ...that are user-owned (warm-pool rows carry a pool_status, so skip them)...
    expect(sql).toContain("pool_status");
    expect(sql).toContain("is null");
    // ...aged past the cutoff (keyed on created_at, not updated_at)...
    expect(sql).toContain("created_at");
    // ...and have NO live agent_provision job.
    expect(sql).toContain("not exists");
    expect(sql).toContain("agent_provision");
    // The job predicate is load-bearing: only LIVE jobs ('pending'/'in_progress')
    // count, so a row whose only agent_provision job is completed/error is still
    // reclaimed. Assert the live-state filter is present and dead states are not.
    expect(sql).toContain("'pending', 'in_progress'");
    expect(sql).not.toContain("'completed'");
    expect(sql).not.toContain("'error'");

    // It MARKS ERROR (it never re-enqueues) with a clear, retry-able message.
    const capturedSet = set.mock.calls.at(-1)?.[0];
    expect(capturedSet?.status).toBe("error");
    expect(String(capturedSet?.error_message)).toContain("no agent_provision job was enqueued");
    // updated_at is bumped so the row no longer matches the cron on the next tick.
    expect(capturedSet?.updated_at instanceof Date).toBe(true);
  });

  test("fleet-upgrade candidates exclude containerless (shared-runtime) agents", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().listRunningWithDigestOtherThan(
      "sha256:target",
      "ghcr.io/elizaos/eliza-agent:prod",
      5,
    );

    if (!capturedWhere)
      throw new Error("listRunningWithDigestOtherThan did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    // Only running, non-deleted, default-image, non-pool rows on a stale digest
    // are upgrade candidates...
    expect(sql).toContain("status");
    expect(sql).toContain("is distinct from");
    expect(sql).toContain("pool_status");
    // ...AND they must actually have a fleet container. Shared-runtime / web-only
    // agents are "running" through the router origin with no node_id /
    // container_name; including them makes executeUpgrade fail forever and the
    // reconciler re-selects them every cycle (an endless agent_upgrade retry
    // storm). The NOT NULL guards on both columns are the fix — assert both.
    expect(sql).toContain("node_id");
    expect(sql).toContain("container_name");
    expect(sql).toContain("is not null");
  });

  test("backup inserts encrypt state_data at rest and hydration returns plaintext", async () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      SQL_HEAVY_PAYLOAD_STORAGE: process.env.SQL_HEAVY_PAYLOAD_STORAGE,
      HEAVY_PAYLOAD_STORAGE: process.env.HEAVY_PAYLOAD_STORAGE,
    };
    process.env.NODE_ENV = "test";
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
    process.env.HEAVY_PAYLOAD_STORAGE = "inline";

    const { resetKmsClientForTests } = await import("../crypto/kms-client");
    const { isEncryptedAgentBackupStateData } = await import("../crypto/agent-backups");
    const { hydrateAgentSandboxBackup, prepareAgentBackupInsertData } = await import(
      "./agent-sandboxes"
    );

    resetKmsClientForTests();

    const backupId = "55555555-5555-4555-8555-555555555555";
    const sandboxRecordId = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
    const organizationId = "22222222-2222-4222-8222-222222222222";
    const createdAt = new Date("2026-06-20T00:00:00.000Z");
    const stateData = {
      memories: [{ role: "user", text: "secret pre-wipe memory", timestamp: 1 }],
      config: { token: "secret-config" },
      workspaceFiles: { "notes.txt": "secret workspace file" },
    };

    try {
      const insertData = await prepareAgentBackupInsertData(
        {
          id: backupId,
          sandbox_record_id: sandboxRecordId,
          snapshot_type: "manual",
          state_data: stateData,
          size_bytes: JSON.stringify(stateData).length,
          backup_kind: "full",
          parent_backup_id: null,
          content_hash: "hash",
          created_at: createdAt,
        },
        organizationId,
      );

      expect(isEncryptedAgentBackupStateData(insertData.state_data)).toBe(true);
      expect(JSON.stringify(insertData.state_data)).not.toContain("secret pre-wipe memory");
      expect(JSON.stringify(insertData.state_data)).not.toContain("secret-config");

      const hydrated = await hydrateAgentSandboxBackup({
        id: backupId,
        sandbox_record_id: sandboxRecordId,
        snapshot_type: "manual",
        state_data: insertData.state_data,
        state_data_storage: "inline",
        state_data_key: null,
        size_bytes: JSON.stringify(stateData).length,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: "hash",
        created_at: createdAt,
      });

      expect(hydrated.state_data).toEqual(stateData);
    } finally {
      resetKmsClientForTests();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test("backup metadata listing does not hydrate encrypted state payloads", async () => {
    selectRows = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        sandbox_record_id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        snapshot_type: "auto",
        state_data: {
          kind: "encrypted-agent-backup-state",
          algorithm: "kms-aes-256-gcm",
          ciphertext: "invalid",
          nonce: "invalid",
          auth_tag: "invalid",
          kms_key_id: "invalid",
          kms_key_version: 1,
        },
        state_data_storage: "inline",
        state_data_key: null,
        size_bytes: 120,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: "hash",
        created_at: new Date("2026-06-20T00:00:00.000Z"),
      },
    ];

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    const rows = await new AgentSandboxesRepository().listBackupMetadata(
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("55555555-5555-4555-8555-555555555555");
    expect(rows[0]?.snapshot_type).toBe("auto");
  });
});

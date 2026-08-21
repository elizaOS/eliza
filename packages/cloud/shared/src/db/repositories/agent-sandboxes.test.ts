/** Exercises sandbox repository behavior with deterministic database fixtures. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realHelpers from "../helpers";

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
let selectRowBatches: unknown[][] = [];

let capturedGroupBy: unknown[] = [];

function chainableRows(): unknown[] & {
  limit: () => unknown[];
  orderBy: () => unknown[] & { limit: () => unknown[]; orderBy: () => unknown[] };
  groupBy: (...columns: unknown[]) => unknown[];
} {
  const sourceRows = selectRowBatches.length > 0 ? selectRowBatches.shift() : selectRows;
  const rows = [...(sourceRows ?? [])] as unknown[] & {
    limit: () => unknown[];
    orderBy: () => unknown[] & { limit: () => unknown[]; orderBy: () => unknown[] };
    groupBy: (...columns: unknown[]) => unknown[];
  };
  rows.limit = () => rows;
  rows.orderBy = () => rows;
  rows.groupBy = (...columns: unknown[]) => {
    capturedGroupBy = columns;
    return rows;
  };
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

// --- claimWarmContainer (C1c) transaction harness ------------------------
// claimWarmContainer runs inside dbWrite.transaction and uses sqlRows(tx, sql`..`)
// (→ tx.execute) for the pool SELECTs, plus tx.select/.update/.delete for the
// user-row read + claim + pool-row delete. Drive it with a per-test controller
// so we can assert the null-node filter behavior without a live DB.
type ExecuteResult = { rows: unknown[]; rowCount?: number };
let executeHandler: (sqlText: string) => ExecuteResult = () => ({ rows: [] });
let userRowForClaim: unknown;
let warmClaimReadWhereClause: SQL | undefined;
let warmClaimWhereClause: SQL | undefined;
const warmClaimUpdateSet = mock((values: Record<string, unknown>) => {
  void values;
  return {
    where: mock((clause: SQL) => {
      warmClaimWhereClause = clause;
      return {
        returning: mock(() => [{ ...(values as Record<string, unknown>), id: "user-row" }]),
      };
    }),
  };
});
const warmClaimDeleteWhere = mock(() => Promise.resolve({ rowCount: 1 }));
function makeTx() {
  return {
    execute: mock((query: SQLWrapper) => {
      const sqlText = new PgDialect().sqlToQuery(query as SQL).sql;
      return Promise.resolve(executeHandler(sqlText));
    }),
    select: mock(() => ({
      from: mock(() => ({
        where: mock((clause: SQL) => {
          warmClaimReadWhereClause = clause;
          return {
            for: mock(() => ({
              limit: mock(() => [userRowForClaim].filter(Boolean)),
            })),
          };
        }),
      })),
    })),
    update: mock(() => ({
      set: useRepositoryTransactionUpdate ? set : warmClaimUpdateSet,
    })),
    delete: mock(() => ({ where: warmClaimDeleteWhere })),
  };
}
const transaction = mock(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
  fn(makeTx()),
);
let useRepositoryMocks = false;
let useTransactionMock = false;
let useWriteSelectMock = false;
let useRepositoryTransactionUpdate = false;

const warnLog = mock((..._args: unknown[]) => {});
const dbReadMock = new Proxy(realHelpers.dbRead as unknown as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "select" && useRepositoryMocks) return select;
    return Reflect.get(target, prop, receiver);
  },
});
const dbWriteMock = new Proxy(realHelpers.dbWrite as unknown as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "update" && useRepositoryMocks) return update;
    if (prop === "select" && useWriteSelectMock) return select;
    if (prop === "transaction" && useTransactionMock) return transaction;
    return Reflect.get(target, prop, receiver);
  },
});

mock.module("../helpers", () => ({
  ...realHelpers,
  dbRead: dbReadMock,
  dbWrite: dbWriteMock,
}));

afterAll(() => {
  mock.module("../helpers", () => realHelpers);
});

mock.module("../ensure-agent-sandbox-schema", () => ({
  ensureAgentSandboxSchema,
}));

mock.module("../../lib/utils/logger", () => ({
  logger: { warn: warnLog, info: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

describe("AgentSandboxesRepository", () => {
  beforeEach(() => {
    useRepositoryMocks = true;
    selectRows = [];
    selectRowBatches = [];
    select.mockClear();
    selectWhere.mockClear();
  });

  afterEach(() => {
    useRepositoryMocks = false;
    useTransactionMock = false;
    useWriteSelectMock = false;
    useRepositoryTransactionUpdate = false;
  });

  test("allows sleeping agents to take the provisioning lock for wake", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().trySetProvisioning("e06bb509-6c52-4c33-a9f7-66addc43e8c8");

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere) throw new Error("trySetProvisioning did not build a where clause");
    expect(new PgDialect().sqlToQuery(capturedWhere).sql).toContain("'sleeping'");
  });

  test("provisioning lock clears stale handles only when retrying permanent provision failures", async () => {
    set.mockClear();

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().trySetProvisioning("e06bb509-6c52-4c33-a9f7-66addc43e8c8");

    const capturedSet = set.mock.calls.at(-1)?.[0];
    if (!capturedSet) throw new Error("trySetProvisioning did not build an update payload");

    const handleColumns = [
      "sandbox_id",
      "bridge_url",
      "health_url",
      "node_id",
      "container_name",
      "bridge_port",
      "web_ui_port",
      "headscale_ip",
    ] as const;

    for (const column of handleColumns) {
      const expression = capturedSet[column];
      const sql =
        expression && typeof expression === "object"
          ? new PgDialect().sqlToQuery(expression as SQL).sql.toLowerCase()
          : "";
      expect(sql).toContain("case when");
      expect(sql).toContain("status");
      expect(sql).toContain("error_message");
      expect(sql).toContain("provisioning permanently failed%");
      expect(sql).toContain("then null");
      expect(sql).toContain(`"${column}" end`);
    }
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
    // #22548: soft-deleted rows and unclaimed warm-pool rows must never be
    // dialed — both guards are present, matching the sibling predicates.
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("pool_status");
    expect((sql.match(/is null/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("dedicated fleet census groups by tier AND status over the container-backed fleet (#22548)", async () => {
    capturedWhere = undefined;
    capturedGroupBy = [];
    select.mockClear();

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().summarizeDedicatedFleet();

    if (!capturedWhere) throw new Error("summarizeDedicatedFleet did not build a where clause");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    const sql = query.sql.toLowerCase();

    // The census must NOT filter on status: the caller applies the serving
    // contract, and it needs the off-state counts (sleeping/stopped) to tell
    // "no agents exist" from "all are asleep". A fleet whose every row sits in
    // `error` — invisible to the heartbeat sweep — must still be counted.
    expect(sql).not.toContain('"status"');
    expect(query.params).not.toContain("running");

    // The tier filter is an explicit allowlist, not `<> 'shared'`, so a tier
    // added later cannot silently enroll itself in the paging census.
    expect(sql).toContain("execution_tier");
    expect(sql).toContain("in (");
    expect(sql).not.toContain("<>");
    expect(query.params).toContain("dedicated-lazy");
    expect(query.params).toContain("dedicated-always");
    expect(query.params).toContain("custom");
    expect(query.params).not.toContain("shared");

    // Deleted and warm-pool rows are not tenant-serving fleet.
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("pool_status");
    expect((sql.match(/is null/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // Tier must be both projected and grouped: a status-only census cannot
    // distinguish a sleeping lazy agent (fine) from a sleeping always-on one.
    const lastSelectArgs = select.mock.calls.at(-1) as unknown as unknown[] | undefined;
    const projection = lastSelectArgs?.[0] as Record<string, unknown> | undefined;
    expect(Object.keys(projection ?? {})).toEqual(
      expect.arrayContaining(["execution_tier", "status", "count"]),
    );
    expect(capturedGroupBy).toHaveLength(2);
    const groupedNames = capturedGroupBy.map((column) => (column as { name?: string }).name);
    expect(groupedNames).toEqual(expect.arrayContaining(["execution_tier", "status"]));
  });

  test("heartbeat writeback is fenced to the exact running generation and loses to deletion", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().update(
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
      { last_heartbeat_at: new Date("2026-07-23T12:00:00.000Z") },
      {
        organizationId: "22222222-2222-4222-8222-222222222222",
        environmentRevision: 7,
        sandboxId: "sandbox-generation-7",
        nodeId: "node-generation-7",
        containerName: "agent-generation-7",
        lifecycleRevision: 42,
      },
    );

    if (!capturedWhere) throw new Error("update did not build a generation fence");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    // The predicate set is pinned by the parameters the statement binds, not by
    // matching column names in its text. That the fence actually REFUSES a
    // stale revision is proved against real PostgreSQL in
    // `__tests__/typed-lifecycle-read.test.ts`, which a text match cannot show.
    const sql = query.sql.toLowerCase();
    expect(sql.match(/is not distinct from/g)).toHaveLength(3);
    expect(query.params).toEqual(
      expect.arrayContaining([
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        "22222222-2222-4222-8222-222222222222",
        "running",
        7,
        "sandbox-generation-7",
        "node-generation-7",
        "agent-generation-7",
        42,
      ]),
    );
  });

  test("generic repository updates cannot write through a durable deletion owner", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");
    await new AgentSandboxesRepository().update("e06bb509-6c52-4c33-a9f7-66addc43e8c8", {
      snapshot_id: "snapshot-after-delete-race",
    });

    if (!capturedWhere) throw new Error("generic update did not build a deletion fence");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    expect(sql).toContain("deletion_attempt_id");
    expect(sql).toContain("is null");
  });

  test("marks only orphaned user-owned pending rows with no provision job as error", async () => {
    capturedWhere = undefined;
    set.mockClear();
    useWriteSelectMock = true;
    useTransactionMock = true;
    useRepositoryTransactionUpdate = true;
    executeHandler = () => ({ rows: [{ acquired: true }] });
    selectRows = [
      {
        agentId: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        organizationId: "22222222-2222-4222-8222-222222222222",
      },
    ];

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    const cutoff = new Date("2026-06-14T00:00:00.000Z");
    await new AgentSandboxesRepository().markOrphanedPendingWithoutJobAsError(cutoff);

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere)
      throw new Error("markOrphanedPendingWithoutJobAsError did not build a where clause");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    const sql = query.sql.toLowerCase();
    // Only `pending` rows are targeted...
    expect(query.params).toContain("pending");
    // ...that are user-owned (warm-pool rows carry a pool_status, so skip them)...
    expect(sql).toContain("pool_status");
    expect(sql).toContain("is null");
    // ...aged past the cutoff (keyed on created_at, not updated_at)...
    expect(sql).toContain("created_at");
    // ...and have NO live agent_provision job.
    expect(sql).toContain("not exists");
    expect(query.params).toContain("agent_provision");
    // Active queue rows retain ownership, as does any generated execution that
    // has not durably acknowledged quiescence.
    expect(query.params).toEqual(expect.arrayContaining(["pending", "in_progress"]));
    expect(sql).toContain("execution_generation");
    expect(sql).toContain("execution_quiesced_at");
    expect(query.params).not.toContain("failed");
    expect(query.params).not.toContain("cancelled");
    expect(query.params).not.toContain("completed");

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
    // that are not already-exhausted against THIS target are upgrade candidates...
    expect(sql).toContain("status");
    expect(sql).toContain("is distinct from");
    expect(sql).toContain("error_message");
    expect(sql).toContain("pool_status");
    // ...AND they must actually have a fleet container. Shared-runtime / web-only
    // agents are "running" through the router origin with no node_id /
    // container_name; including them makes executeUpgrade fail forever and the
    // reconciler re-selects them every cycle (an endless agent_upgrade retry
    // storm). The NOT NULL guards on both columns are the fix — assert both.
    expect(sql).toContain("node_id");
    expect(sql).toContain("container_name");
    expect(sql).toContain("is not null");

    // The default-image predicate normalizes docker_image to its REPO before
    // comparing (#15101), so a fleet agent pinned to an older tag/digest of the
    // same repo is still a candidate. It must NOT compare the full ref — assert
    // the normalization (split_part strips @digest; reverse locates the tag
    // colon) is present and the bound value is the target REPO, not its tag.
    const { params } = new PgDialect().sqlToQuery(capturedWhere);
    expect(sql).toContain("split_part");
    expect(sql).toContain("reverse");
    expect(params).toContain("ghcr.io/elizaos/eliza-agent");
    expect(params).not.toContain("ghcr.io/elizaos/eliza-agent:prod");
  });

  test("markRunningFromProvisioning refuses rows without durable node attribution", async () => {
    capturedWhere = undefined;
    useWriteSelectMock = true;
    useTransactionMock = true;
    useRepositoryTransactionUpdate = true;
    selectRows = [{ organizationId: "22222222-2222-4222-8222-222222222222" }];

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");
    await new AgentSandboxesRepository().markRunningFromProvisioning(
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    );

    if (!capturedWhere) throw new Error("markRunningFromProvisioning did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    expect(sql).toContain("sandbox_id");
    expect(sql).toContain("node_id");
    expect(sql).toContain("is not null");
    expect(sql).toContain("<> ''");
  });

  test("fleet-upgrade candidates re-arm on a NEW target after a rollback-safe upgrade failure (#15357)", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");
    const { UPGRADE_FAILURE_TARGET_MARKER_PREFIX } = await import("../schemas/agent-sandboxes");

    const targetDigest = "sha256:target";
    await new AgentSandboxesRepository().listRunningWithDigestOtherThan(
      targetDigest,
      "ghcr.io/elizaos/eliza-agent:prod",
      5,
    );

    if (!capturedWhere)
      throw new Error("listRunningWithDigestOtherThan did not build a where clause");
    const { sql, params } = new PgDialect().sqlToQuery(capturedWhere);
    const lower = sql.toLowerCase();

    // The rollback-safe exclusion must be digest-AWARE, not a blanket
    // `error_message IS NULL`. A single transient rollback-safe failure must
    // NOT permanently freeze an always-on agent out of ALL future upgrades
    // (NubsCarson's #15311 adversarial finding). The predicate re-arms the row
    // for a NEWER target while still skipping a re-enqueue of the SAME doomed
    // target. Assert both the marker probe and the exact-target probe are
    // present, and that the target-scoped bind carries THIS target digest.
    expect(lower).toContain("error_message");
    expect(lower).toContain("not like");
    // Marker-presence bind (any upgrade-failure marker) and the exact-target
    // bind (marker for THIS target only) are both parameterized.
    expect(params).toContain(`%${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}%`);
    expect(params).toContain(`%${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}${targetDigest}]%`);
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

      const storedFixture = {
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
        recovery_organization_id: null,
        recovery_agent_id: null,
        recovery_deletion_attempt_id: null,
        recovery_expires_at: null,
        verification_status: null,
        verified_at: null,
        verification_error: null,
        created_at: createdAt,
      } as Parameters<typeof hydrateAgentSandboxBackup>[0];
      const hydrated = await hydrateAgentSandboxBackup(storedFixture);

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
        verification_status: null,
        verified_at: null,
        verification_error: null,
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

  test("incremental reconstruction walks only the target chain sequentially", async () => {
    useWriteSelectMock = true;
    const { AgentSandboxesRepository } = await import("./agent-sandboxes");
    const { diffBackupState, computeStateHash } = await import(
      "../../lib/services/agent-backup-diff"
    );

    const sandboxId = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
    const fullId = "11111111-1111-4111-8111-111111111111";
    const incrementalId = "22222222-2222-4222-8222-222222222222";
    const baseState = {
      memories: [{ role: "user", text: "base", timestamp: 1 }],
      config: { mood: "steady" },
      workspaceFiles: { "notes.txt": "base" },
    };
    const nextState = {
      memories: [
        { role: "user", text: "base", timestamp: 1 },
        { role: "assistant", text: "next", timestamp: 2 },
      ],
      config: { mood: "awake" },
      workspaceFiles: { "notes.txt": "next" },
    };
    const createdAt = new Date("2026-07-09T00:00:00.000Z");

    selectRowBatches = [
      [
        {
          id: incrementalId,
          sandbox_record_id: sandboxId,
          snapshot_type: "auto",
          state_data: diffBackupState(baseState, nextState),
          state_data_storage: "inline",
          state_data_key: null,
          size_bytes: 256,
          backup_kind: "incremental",
          parent_backup_id: fullId,
          content_hash: computeStateHash(nextState),
          verification_status: null,
          verified_at: null,
          verification_error: null,
          created_at: createdAt,
        },
      ],
      [
        {
          id: fullId,
          sandbox_record_id: sandboxId,
          snapshot_type: "auto",
          state_data: baseState,
          state_data_storage: "inline",
          state_data_key: null,
          size_bytes: 256,
          backup_kind: "full",
          parent_backup_id: null,
          content_hash: computeStateHash(baseState),
          verification_status: null,
          verified_at: null,
          verification_error: null,
          created_at: createdAt,
        },
      ],
    ];

    const reconstructed = await new AgentSandboxesRepository().getReconstructedBackupState(
      incrementalId,
    );

    expect(reconstructed).toEqual(nextState);
    expect(selectWhere).toHaveBeenCalledTimes(2);
  });

  // C1c attribution guard (audit §C1c): claimWarmContainer must NEVER mint a
  // user-facing running row from a pool entry with a null/empty node_id. Pool
  // rows can carry a null node_id (the creator tolerates it), and a claim
  // copies node_id verbatim then DELETEs the pool row — leaving an
  // unattributable orphan with no record to reconcile against.
  describe("claimWarmContainer ownership and readiness guards", () => {
    const IMAGE = "ghcr.io/example/bnancy:latest";
    const params = {
      userAgentId: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
      organizationId: "22222222-2222-4222-8222-222222222222",
      image: IMAGE,
      agentName: "bnancy",
    };

    function pendingUserRow() {
      return {
        id: params.userAgentId,
        organization_id: params.organizationId,
        status: "pending",
        execution_tier: "dedicated-always",
        database_status: null,
        database_uri: null,
        deletion_attempt_id: null,
        deletion_started_at: null,
        claimed_at: null,
        warm_claim_credential_state: null,
        agent_config: {},
        character_id: null,
        lifecycle_revision: 7,
        updated_at: new Date("2026-07-07T12:00:00.000Z"),
      };
    }

    beforeEach(() => {
      useTransactionMock = true;
      warmClaimReadWhereClause = undefined;
      warmClaimWhereClause = undefined;
    });

    afterEach(() => {
      useTransactionMock = false;
    });

    test("the claim SELECT filters out null/empty node_id pool rows", async () => {
      userRowForClaim = pendingUserRow();
      let claimSelectSql = "";
      executeHandler = (sqlText: string) => {
        // The first/main SELECT is the pool-claim query. Capture it and return
        // no rows so the guard's empty-pool branch runs.
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          claimSelectSql = sqlText;
          return { rows: [] };
        }
        // The skip-count query.
        return { rows: [{ count: 0 }] };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      const result = await new AgentSandboxesRepository().claimWarmContainer(params);

      expect(result).toBeNull();
      const lowered = claimSelectSql.toLowerCase();
      expect(lowered).toContain("node_id");
      expect(lowered).toContain("is not null");
    });

    // F2 (warm-pool flip report): claim readiness must require a resolved
    // BRIDGE URL, not just docker-health (`pool_ready_at`). An entry whose
    // bridge_url never resolved is unreachable and would hand the user a dead
    // container. The SELECT must gate on bridge_url present AND non-empty.
    test("the claim SELECT requires a non-null, non-empty bridge_url (F2)", async () => {
      userRowForClaim = pendingUserRow();
      let claimSelectSql = "";
      executeHandler = (sqlText: string) => {
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          claimSelectSql = sqlText;
          return { rows: [] };
        }
        return { rows: [{ count: 0 }] };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      const result = await new AgentSandboxesRepository().claimWarmContainer(params);

      expect(result).toBeNull();
      const lowered = claimSelectSql.toLowerCase();
      expect(lowered).toContain("bridge_url");
      // present (IS NOT NULL) AND non-empty (<> '')
      const bridgeClauseMatch = lowered.match(/bridge_url[^)]*is not null/);
      expect(bridgeClauseMatch).not.toBeNull();
      expect(lowered).toContain("<> ''");
    });

    test("a valid (non-null-node) pool row IS claimed — guard does not over-filter", async () => {
      userRowForClaim = {
        ...pendingUserRow(),
        environment_vars: {
          ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
          USER_SETTING: "preserved",
        },
      };
      warmClaimUpdateSet.mockClear();
      warmClaimDeleteWhere.mockClear();
      const validPool = {
        id: "pool-1",
        pool_status: "unclaimed",
        status: "running",
        execution_tier: "shared",
        docker_image: IMAGE,
        image_digest: `sha256:${"a".repeat(64)}`,
        pool_ready_at: new Date("2026-07-07T11:00:00.000Z"),
        node_id: "node-1",
        container_name: "agent-pool-1",
        bridge_port: 21060,
        web_ui_port: 3000,
        headscale_ip: "100.64.0.11",
        bridge_url: "http://100.64.0.11:3000",
        health_url: "http://100.64.0.11:3000/api",
        sandbox_id: "agent-pool-1",
        database_uri: "postgres://pool-db",
        database_status: "ready",
        environment_vars: {
          ELIZA_API_TOKEN: "pool-live-token",
          ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
        },
      };
      executeHandler = (sqlText: string) => {
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          // The filtered query returns the valid candidate.
          return { rows: [validPool] };
        }
        return { rows: [{ count: 0 }] };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      const result = await new AgentSandboxesRepository().claimWarmContainer({
        ...params,
        expectedLifecycleRevision: 7,
      });

      expect(result).not.toBeNull();
      // The claim inherited the pool row's REAL node_id (never a null).
      const setArg = warmClaimUpdateSet.mock.calls[0]?.[0] as {
        node_id?: string;
        status?: string;
        image_digest?: string;
        environment_vars?: Record<string, string>;
        warm_claim_credential_state?: string;
        warm_claim_source_pool_id?: string;
      };
      expect(setArg.status).toBe("provisioning");
      expect(setArg.node_id).toBe("node-1");
      expect(setArg.image_digest).toBe(validPool.image_digest);
      expect(setArg.environment_vars).toMatchObject({
        ELIZA_API_TOKEN: "pool-live-token",
        ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
        USER_SETTING: "preserved",
      });
      expect(setArg.warm_claim_credential_state).toBe("pending");
      expect(setArg.warm_claim_source_pool_id).toBe("pool-1");
      // Pool row deleted on claim (single record now the user's).
      expect(warmClaimDeleteWhere).toHaveBeenCalledTimes(1);
      // The DELETED pool row's id rides out on the claimed row: the container's
      // boot inference key is named `agent-sandbox:<pool row id>`, and the
      // post-claim re-key can only revoke that pool-org credential if the claim
      // carries the id out of the transaction (#17066 review — the claimed
      // row's own id can never reach that key name).
      expect(result?.warm_pool_row_id).toBe("pool-1");
      if (!warmClaimReadWhereClause) throw new Error("Warm claim did not guard its target read");
      const readQuery = new PgDialect().sqlToQuery(warmClaimReadWhereClause);
      expect(readQuery.sql.toLowerCase()).toContain("execution_tier");
      expect(readQuery.sql.toLowerCase()).toContain("pool_status");
      expect(readQuery.sql.toLowerCase()).toContain("deleted_at");
      expect(readQuery.params).toEqual(
        expect.arrayContaining(["dedicated-lazy", "dedicated-always", "custom"]),
      );
      expect(readQuery.params).not.toContain("shared");
      if (!warmClaimWhereClause) throw new Error("Warm claim did not build an update predicate");
      const updateQuery = new PgDialect().sqlToQuery(warmClaimWhereClause);
      const updateSql = updateQuery.sql.toLowerCase();
      expect(updateSql).toContain("organization_id");
      expect(updateSql).toContain("execution_tier");
      expect(updateSql).toContain("pool_status");
      expect(updateSql).toContain("deleted_at");
      expect(updateQuery.params).toEqual(
        expect.arrayContaining(["dedicated-lazy", "dedicated-always", "custom"]),
      );
      expect(updateQuery.params).not.toContain("shared");
      expect(updateSql).toContain("deletion_attempt_id");
      expect(updateSql).toContain("deletion_pending");
      expect(updateSql).toContain("deletion_failed");
      expect(updateSql).toContain("lifecycle_revision");
    });

    test("a Shared target is refused before any pool transfer", async () => {
      userRowForClaim = { ...pendingUserRow(), execution_tier: "shared" };
      warmClaimUpdateSet.mockClear();
      warmClaimDeleteWhere.mockClear();
      executeHandler = (sqlText: string) => {
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          return {
            rows: [
              {
                id: "legacy-shared-pool-source",
                pool_status: "unclaimed",
                status: "running",
                execution_tier: "shared",
                docker_image: IMAGE,
                image_digest: `sha256:${"d".repeat(64)}`,
                pool_ready_at: new Date("2026-07-07T11:00:00.000Z"),
                node_id: "legacy-node",
                container_name: "legacy-container",
                bridge_url: "http://100.64.0.11:3000",
              },
            ],
          };
        }
        return { rows: [] };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      await expect(new AgentSandboxesRepository().claimWarmContainer(params)).resolves.toBeNull();
      expect(warmClaimUpdateSet).not.toHaveBeenCalled();
      expect(warmClaimDeleteWhere).not.toHaveBeenCalled();
    });

    test("a stale lifecycle revision cannot consume a warm pool container", async () => {
      userRowForClaim = { ...pendingUserRow(), lifecycle_revision: 8 };
      warmClaimUpdateSet.mockClear();
      warmClaimDeleteWhere.mockClear();
      executeHandler = (sqlText: string) => {
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          return {
            rows: [
              {
                id: "pool-stale-claim",
                pool_status: "unclaimed",
                status: "running",
                docker_image: IMAGE,
                image_digest: `sha256:${"b".repeat(64)}`,
                pool_ready_at: new Date("2026-07-07T11:00:00.000Z"),
                node_id: "node-1",
                container_name: "agent-pool-stale-claim",
                bridge_url: "http://100.64.0.11:3000",
              },
            ],
          };
        }
        return { rows: [] };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      const result = await new AgentSandboxesRepository().claimWarmContainer({
        ...params,
        expectedLifecycleRevision: 7,
      });

      expect(result).toBeNull();
      expect(warmClaimUpdateSet).not.toHaveBeenCalled();
      expect(warmClaimDeleteWhere).not.toHaveBeenCalled();
    });

    test("a deletion-owned user row cannot consume a warm pool container", async () => {
      userRowForClaim = {
        ...pendingUserRow(),
        status: "deletion_pending",
        deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        deletion_started_at: new Date("2026-07-23T12:30:00.000Z"),
      };
      warmClaimUpdateSet.mockClear();
      warmClaimDeleteWhere.mockClear();
      executeHandler = (sqlText: string) => {
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          return {
            rows: [
              {
                id: "pool-delete-race",
                pool_status: "unclaimed",
                status: "running",
                docker_image: IMAGE,
                image_digest: `sha256:${"a".repeat(64)}`,
                pool_ready_at: new Date("2026-07-07T11:00:00.000Z"),
                node_id: "node-1",
                container_name: "agent-pool-delete-race",
                bridge_url: "http://100.64.0.11:3000",
              },
            ],
          };
        }
        return { rows: [] };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      const result = await new AgentSandboxesRepository().claimWarmContainer(params);

      expect(result).toBeNull();
      expect(warmClaimUpdateSet).not.toHaveBeenCalled();
      expect(warmClaimDeleteWhere).not.toHaveBeenCalled();
    });

    test("countUnclaimedPool excludes null/empty node_id rows (ready == claimable)", async () => {
      // A poisoned null-node pool row must NOT count as ready capacity, or the
      // replenisher sees a full pool while every claim skips it (starvation).
      capturedWhere = undefined;
      selectRows = [{ count: 0 }];
      useWriteSelectMock = true;

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      await new AgentSandboxesRepository().countUnclaimedPool({ image: IMAGE });

      if (!capturedWhere) throw new Error("countUnclaimedPool did not build a where clause");
      const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
      expect(sql).toContain("node_id");
      expect(sql).toContain("is not null");
      // and the empty-string exclusion
      expect(sql).toContain("<> ''");
    });

    test("pool with ONLY null-node entries: returns null cleanly + warns on skip", async () => {
      userRowForClaim = pendingUserRow();
      warnLog.mockClear();
      executeHandler = (sqlText: string) => {
        if (sqlText.includes("FOR UPDATE SKIP LOCKED")) {
          // Filtered query finds nothing (the only entries are null-node).
          return { rows: [] };
        }
        // Skip-count query: two null-node rows were left behind.
        return {
          rows: [
            {
              count: 2,
              missing_bridge: 0,
              missing_node: 2,
              missing_readiness: 0,
            },
          ],
        };
      };

      const { AgentSandboxesRepository } = await import("./agent-sandboxes");
      const result = await new AgentSandboxesRepository().claimWarmContainer(params);

      // Clean null return → caller falls through to the cold provision path
      // (which enforces the C1b guard).
      expect(result).toBeNull();
      // Observability: the skip is warned (not silent) with the counter event.
      const warned = warnLog.mock.calls.some((c) => {
        const meta = c[1] as
          | { event?: string; skippedCount?: number; missingNodeCount?: number }
          | undefined;
        return (
          meta?.event === "warm_pool.unclaimable_entries_skipped" &&
          meta.skippedCount === 2 &&
          meta.missingNodeCount === 2
        );
      });
      expect(warned).toBe(true);
    });
  });
});

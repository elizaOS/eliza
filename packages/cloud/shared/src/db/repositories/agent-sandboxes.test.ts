/** Exercises sandbox repository behavior with deterministic database fixtures. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realHelpers from "../helpers";
import type { ProvisioningAdmissionCapture, ProvisioningRecoveryCapture } from "./agent-sandboxes";

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

// Retained update tests observe their existing transaction statements. Admission
// and warm-pool ownership run against real PGlite in the readiness suite.
type ExecuteResult = { rows: unknown[]; rowCount?: number };
let executeHandler: (sqlText: string) => ExecuteResult = () => ({ rows: [] });
function makeTx() {
  return {
    execute: mock((query: SQLWrapper) => {
      const sqlText = new PgDialect().sqlToQuery(query as SQL).sql;
      return Promise.resolve(executeHandler(sqlText));
    }),
    update: mock(() => ({ set })),
  };
}
const transaction = mock(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
  fn(makeTx()),
);
let useRepositoryMocks = false;
let useTransactionMock = false;
let useWriteSelectMock = false;

const warnLog = mock((..._args: unknown[]) => {});

function restoreProvisioningCapture(
  overrides: Partial<ProvisioningAdmissionCapture> = {},
): ProvisioningAdmissionCapture {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "c21ed7f4-4d97-4b69-a09a-71a6af758591",
    status: "stopped",
    lifecycle_job_id: null,
    lifecycle_execution_generation: null,
    execution_tier: "dedicated-lazy",
    pool_status: null,
    deleted_at: null,
    deletion_attempt_id: null,
    lifecycle_revision: 47,
    ...overrides,
  };
}

function provisioningRecoveryCapture(
  overrides: Partial<ProvisioningRecoveryCapture> = {},
): ProvisioningRecoveryCapture {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "c21ed7f4-4d97-4b69-a09a-71a6af758591",
    status: "provisioning",
    execution_tier: "dedicated-always",
    sandbox_id: "sandbox-generation-7",
    node_id: "node-generation-7",
    container_name: "container-generation-7",
    bridge_url: "https://bridge-generation-7.example",
    health_url: "https://bridge-generation-7.example/api/health",
    headscale_ip: "100.64.0.7",
    environment_revision: 7,
    lifecycle_revision: 42,
    lifecycle_job_id: null,
    lifecycle_execution_generation: null,
    pool_status: null,
    deleted_at: null,
    deletion_attempt_id: null,
    ...overrides,
  };
}

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
    useWriteSelectMock = false;
    useTransactionMock = false;
  });

  test("restore provisioning admission rejects a forbidden capture before any database action", async () => {
    const { AgentSandboxesRepository } = await import("./agent-sandboxes");
    const repository = new AgentSandboxesRepository();

    const forbidden: ProvisioningAdmissionCapture[] = [
      restoreProvisioningCapture({ status: "pending" }),
      restoreProvisioningCapture({ status: "provisioning" }),
      restoreProvisioningCapture({ status: "running" }),
      restoreProvisioningCapture({ status: "deletion_pending" }),
      restoreProvisioningCapture({ status: "deletion_failed" }),
      restoreProvisioningCapture({
        lifecycle_job_id: "d9f62174-4c24-421e-bb93-192dc0a5882c",
        lifecycle_execution_generation: "f35b93df-ad0d-480c-bf72-1e8fcb55de42",
      }),
      restoreProvisioningCapture({ execution_tier: "shared" }),
      restoreProvisioningCapture({ pool_status: "unclaimed" }),
      restoreProvisioningCapture({ deleted_at: new Date("2026-08-23T00:00:00.000Z") }),
      restoreProvisioningCapture({
        deletion_attempt_id: "8ec9c406-838c-4fe4-ac2d-3d3dd2db1a3f",
      }),
    ];

    for (const capture of forbidden) {
      update.mockClear();
      ensureAgentSandboxSchema.mockClear();
      await expect(
        repository.trySetProvisioningFromRestoreCapture(capture),
      ).resolves.toBeUndefined();
      expect(ensureAgentSandboxSchema).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
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
    // ...and only the canonical container-backed tiers are admitted. An
    // unknown future tier must not silently join the heartbeat fleet.
    expect(sql).toContain("execution_tier");
    expect(sql).toContain(" in ");
    // Drizzle binds allowlist values as params.
    expect(query.params).toContain("running");
    expect(query.params).toContain("dedicated-lazy");
    expect(query.params).toContain("dedicated-always");
    expect(query.params).toContain("custom");
    expect(query.params).not.toContain("shared");
    expect(query.params).not.toContain("future-container-tier");
    // #22548: soft-deleted rows and unclaimed warm-pool rows must never be
    // dialed — both guards are present, matching the sibling predicates.
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("pool_status");
    expect((sql.match(/is null/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("single-agent runtime lookup explicitly admits Shared and the three container tiers", async () => {
    capturedWhere = undefined;
    useWriteSelectMock = true;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().findRunningSandbox(
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
      "c21ed7f4-4d97-4b69-a09a-71a6af758591",
    );

    if (!capturedWhere) throw new Error("findRunningSandbox did not build a where clause");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    expect(query.sql.toLowerCase()).toContain("execution_tier");
    expect(query.params).toContain("dedicated-lazy");
    expect(query.params).toContain("dedicated-always");
    expect(query.params).toContain("custom");
    expect(query.params).toContain("shared");
    expect(query.params).not.toContain("future-container-tier");
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
    useTransactionMock = true;

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
        "dedicated-lazy",
        "dedicated-always",
        "custom",
      ]),
    );
    expect(query.params).not.toContain("shared");
    expect(query.params).not.toContain("future-container-tier");
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

  test("markRunningFromProvisioning fences the exact probed generation and active ownership", async () => {
    capturedWhere = undefined;
    useTransactionMock = true;
    executeHandler = () => ({ rows: [{ acquired: true }] });

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");
    await new AgentSandboxesRepository().markRunningFromProvisioning(provisioningRecoveryCapture());

    if (!capturedWhere) throw new Error("markRunningFromProvisioning did not build a where clause");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    const sql = query.sql.toLowerCase();
    expect(sql).toContain("sandbox_id");
    expect(sql).toContain("node_id");
    expect(sql).toContain("container_name");
    expect(sql).toContain("execution_tier");
    expect(sql.match(/is not distinct from/g)).toHaveLength(6);
    expect(sql).toContain("environment_revision");
    expect(sql).toContain("lifecycle_revision");
    expect(sql).toContain("lifecycle_job_id");
    expect(sql).toContain("lifecycle_execution_generation");
    expect(sql).toContain("pool_status");
    expect(sql).toContain("not exists");
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("deletion_attempt_id");
    expect(query.params).toEqual(
      expect.arrayContaining([
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        "c21ed7f4-4d97-4b69-a09a-71a6af758591",
        "provisioning",
        "dedicated-always",
        "sandbox-generation-7",
        "node-generation-7",
        "container-generation-7",
        "https://bridge-generation-7.example",
        "https://bridge-generation-7.example/api/health",
        "100.64.0.7",
        7,
        42,
      ]),
    );
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
});

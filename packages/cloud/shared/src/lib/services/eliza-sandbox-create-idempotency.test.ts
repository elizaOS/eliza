/**
 * App-level create-vs-reuse idempotency for ElizaSandboxService.createAgent.
 *
 * The org-scoped advisory lock + FOR UPDATE reuse guard (mirroring
 * createCodingContainerAgent) must collapse retries / SDK double-calls /
 * provision flaps into ONE agent per org for the opt-in single-agent flows,
 * while leaving the multi-agent-per-org service paths (compat, waifu) free to
 * mint distinct agents.
 *
 * `dbWrite` is a Proxy spyOn can't intercept, so this file mock.modules the
 * helpers with a chainable tx builder that captures the generated SQL — exactly
 * the boundary the real transaction sits behind. Everything else is real.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { AgentSandbox, NewAgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";

// ---- captured tx state, reconfigured per test ----
let existingRows: AgentSandbox[] = [];
let insertedRows: NewAgentSandbox[] = [];
let capturedSelectWhere: SQL | undefined;
let executeCalls: number = 0;
// The capped (#11023) path's `select({count}).from().where()` is AWAITED at
// `.where()` (no orderBy/for/limit), so the chain is thenable and resolves to
// these count rows. The reuse guard instead ends in `.limit()` (returns
// existingRows), so it never hits the thenable.
let countRows: Array<{ count: number }> = [{ count: 0 }];

const txExecute = mock(async (_sql: SQL) => {
  executeCalls += 1;
  return { rows: [] };
});

// reuse guard:  select().from().where(clause).orderBy().for("update").limit() -> existingRows
// cap count:    select({count}).from().where(clause) [awaited]               -> countRows
const txSelect = mock(() => {
  const chain = {
    from: () => chain,
    where: (clause: SQL) => {
      capturedSelectWhere = clause;
      return chain;
    },
    orderBy: () => chain,
    for: () => chain,
    limit: () => existingRows,
    then: (resolve: (rows: Array<{ count: number }>) => unknown) =>
      resolve(countRows),
  } as Record<string, unknown>;
  return chain;
});

// tx.insert().values(data).returning() -> [the row that would be created]
const txInsertValues = mock((data: NewAgentSandbox) => {
  insertedRows.push(data);
  const created: AgentSandbox = {
    ...baseRow(),
    ...data,
    id: `created-${insertedRows.length}`,
  } as AgentSandbox;
  return { returning: mock(async () => [created]) };
});
const txInsert = mock(() => ({ values: txInsertValues }));

const tx = { execute: txExecute, select: txSelect, insert: txInsert };
const transaction = mock(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

const dbWriteMock = { transaction };

mock.module("../../db/helpers", () => ({
  db: dbWriteMock,
  dbRead: { select: () => ({}), query: {} },
  dbWrite: dbWriteMock,
  getDbConnectionInfo: () => ({}),
  getReadDb: () => dbWriteMock,
  getWriteDb: () => dbWriteMock,
  getDbRoutingInfo: () => ({}),
  logDbRouting: () => {},
  useReadDb: (fn: (d: unknown) => unknown) => fn(dbWriteMock),
  useWriteDb: (fn: (d: unknown) => unknown) => fn(dbWriteMock),
  readQuery: async (_label: string, fn: (d: unknown) => unknown) => fn(dbWriteMock),
  writeQuery: async (_label: string, fn: (d: unknown) => unknown) => fn(dbWriteMock),
  writeTransaction: (fn: (t: typeof tx) => Promise<unknown>) => transaction(fn),
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

function baseRow(): AgentSandbox {
  const now = new Date("2026-06-24T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000000",
    organization_id: ORG_A,
    user_id: USER,
    character_id: null,
    sandbox_id: null,
    status: "pending",
    execution_tier: "custom",
    bridge_url: null,
    health_url: null,
    agent_name: "agent",
    agent_config: {},
    database_uri: null,
    database_status: "none",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: {},
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: "ghcr.io/example/agent:latest",
    image_digest: null,
    previous_image_digest: null,
    previous_docker_image: null,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  } as AgentSandbox;
}

function resetTx(): void {
  existingRows = [];
  insertedRows = [];
  capturedSelectWhere = undefined;
  executeCalls = 0;
  countRows = [{ count: 0 }];
  txExecute.mockClear();
  txSelect.mockClear();
  txInsert.mockClear();
  txInsertValues.mockClear();
  transaction.mockClear();
}

afterEach(() => {
  resetTx();
});

describe("ElizaSandboxService.createAgent — opt-in org reuse guard", () => {
  test("(a) two reuse-flagged creates for one org collapse to the same agent — 2nd is idempotent, no 2nd insert", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();

    // 1st call: no existing non-terminal row → inserts.
    existingRows = [];
    const first = await svc.createAgent({
      organizationId: ORG_A,
      userId: USER,
      agentName: "alpha",
      dockerImage: "ghcr.io/example/agent:latest",
      reuseExistingNonTerminal: true,
    });
    expect(first.idempotent).toBe(false);
    expect(insertedRows.length).toBe(1);
    expect(executeCalls).toBe(1); // advisory lock taken

    // 2nd call: the just-created row is now the org's non-terminal agent.
    existingRows = [{ ...baseRow(), id: first.agent.id, organization_id: ORG_A }];
    const second = await svc.createAgent({
      organizationId: ORG_A,
      userId: USER,
      agentName: "alpha-retry",
      dockerImage: "ghcr.io/example/agent:latest",
      reuseExistingNonTerminal: true,
    });
    expect(second.idempotent).toBe(true);
    expect(second.agent.id).toBe(first.agent.id);
    // No second insert — still exactly one created row across both calls.
    expect(insertedRows.length).toBe(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
  });

  test("(b) a create for a DIFFERENT org still mints a distinct agent", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();

    // Org B has no non-terminal agent of its own → fresh insert.
    existingRows = [];
    const res = await svc.createAgent({
      organizationId: ORG_B,
      userId: USER,
      agentName: "beta",
      dockerImage: "ghcr.io/example/agent:latest",
      reuseExistingNonTerminal: true,
    });
    expect(res.idempotent).toBe(false);
    expect(insertedRows.length).toBe(1);
    expect(insertedRows[0]?.organization_id).toBe(ORG_B);
  });

  test("(c) an org whose only agent is terminal creates a fresh one (guard filters to non-terminal)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();

    // The guard's WHERE excludes terminal statuses, so the SELECT returns []
    // even though a deleted/errored row exists — modeled by existingRows = [].
    existingRows = [];
    const res = await svc.createAgent({
      organizationId: ORG_A,
      userId: USER,
      agentName: "gamma",
      dockerImage: "ghcr.io/example/agent:latest",
      reuseExistingNonTerminal: true,
    });
    expect(res.idempotent).toBe(false);
    expect(insertedRows.length).toBe(1);

    // The reuse SELECT must scope to the org AND filter to non-terminal
    // statuses only — a terminal-only org must never reuse a doomed row.
    expect(capturedSelectWhere).toBeDefined();
    const sql = new PgDialect().sqlToQuery(capturedSelectWhere as SQL).sql;
    expect(sql).toContain("organization_id");
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'provisioning'");
    expect(sql).toContain("'running'");
    expect(sql).not.toContain("'deleted'");
  });

  test("multi-agent path (flag unset) bypasses the guard and always inserts via the repository", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();

    const repoCreate = spyOn(agentSandboxesRepository, "create").mockResolvedValue({
      ...baseRow(),
      id: "repo-created",
    });
    try {
      const res = await svc.createAgent({
        organizationId: ORG_A,
        userId: USER,
        agentName: "no-reuse",
        dockerImage: "ghcr.io/example/agent:latest",
      });
      expect(res.idempotent).toBe(false);
      expect(res.agent.id).toBe("repo-created");
      // No transaction, no advisory lock, no reuse SELECT on the multi-agent path.
      expect(transaction).not.toHaveBeenCalled();
      expect(txExecute).not.toHaveBeenCalled();
      expect(repoCreate).toHaveBeenCalledTimes(1);
    } finally {
      repoCreate.mockRestore();
    }
  });
});

describe("ElizaSandboxService.createAgent — forceCreate per-org quota (#11023)", () => {
  test("a fresh (non-reuse) create under maxNonTerminalAgents inserts, atomically under the advisory lock", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();

    // Org already has 3 live agents; cap is 5 → the create proceeds.
    countRows = [{ count: 3 }];
    const res = await svc.createAgent({
      organizationId: ORG_A,
      userId: USER,
      agentName: "forced-under-cap",
      dockerImage: "ghcr.io/example/agent:latest",
      reuseExistingNonTerminal: false,
      maxNonTerminalAgents: 5,
    });

    expect(res.idempotent).toBe(false);
    expect(insertedRows.length).toBe(1);
    // The count + insert ran inside the transaction that first took the org
    // advisory lock — so the check and the write are atomic (no TOCTOU).
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executeCalls).toBe(1);
    // The count scoped to this org AND to non-terminal statuses only.
    expect(capturedSelectWhere).toBeDefined();
    const sql = new PgDialect().sqlToQuery(capturedSelectWhere as SQL).sql;
    expect(sql).toContain("organization_id");
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'provisioning'");
    expect(sql).toContain("'running'");
  });

  test("a fresh create AT the cap is refused with AgentQuotaExceededError and NO insert (fleet-DoS closed)", async () => {
    const { ElizaSandboxService, AgentQuotaExceededError } = await import(
      "./eliza-sandbox.ts?actual"
    );
    const svc = new ElizaSandboxService();

    // Org is already at the cap → a fresh forceCreate must not mint another.
    countRows = [{ count: 5 }];
    await expect(
      svc.createAgent({
        organizationId: ORG_A,
        userId: USER,
        agentName: "forced-at-cap",
        dockerImage: "ghcr.io/example/agent:latest",
        reuseExistingNonTerminal: false,
        maxNonTerminalAgents: 5,
      }),
    ).rejects.toBeInstanceOf(AgentQuotaExceededError);

    // The lock was taken (so the count was authoritative) but NO row was inserted.
    expect(executeCalls).toBe(1);
    expect(insertedRows.length).toBe(0);
  });

  test("an unset cap keeps the uncapped plain-insert fast path (trusted internal multi-agent callers)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();

    const repoCreate = spyOn(agentSandboxesRepository, "create").mockResolvedValue({
      ...baseRow(),
      id: "repo-created-uncapped",
    });
    try {
      // Even with many existing agents, an unset cap does NOT gate the insert.
      countRows = [{ count: 999 }];
      const res = await svc.createAgent({
        organizationId: ORG_A,
        userId: USER,
        agentName: "waifu-launch",
        dockerImage: "ghcr.io/example/agent:latest",
        reuseExistingNonTerminal: false,
        // maxNonTerminalAgents intentionally unset
      });
      expect(res.agent.id).toBe("repo-created-uncapped");
      // No transaction / advisory lock / count query on the uncapped path.
      expect(transaction).not.toHaveBeenCalled();
      expect(txExecute).not.toHaveBeenCalled();
      expect(repoCreate).toHaveBeenCalledTimes(1);
    } finally {
      repoCreate.mockRestore();
    }
  });
});

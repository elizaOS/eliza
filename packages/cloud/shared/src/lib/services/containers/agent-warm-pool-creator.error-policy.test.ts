/**
 * Error-policy pins for `HetznerPoolContainerCreator` (#13415).
 *
 * This is the concrete warm-pool creator sitting on the Hetzner/Neon
 * provisioning path. Doctrine for the container-provisioning domain: an
 * *internal failure* of a provision/destroy/DB call must PROPAGATE (throw), so
 * the WarmPoolManager records it as a real failure — it must never be swallowed
 * into a phantom "success" (a leaked pool row that reads as destroyed, a
 * fabricated pool id from a failed provision). A *legitimately-empty* outcome (a
 * row already gone, an idempotent 404-as-success, an unreachable liveness probe)
 * stays DISTINCT: it resolves/returns a designed value rather than throwing.
 *
 * Drives the real exported `getHetznerPoolContainerCreator()` with the DB
 * repository, sandbox service and schema constant `mock.module`-stubbed and the
 * module dynamically imported after the stubs install; `global.fetch` is stubbed
 * for the liveness probe and restored per-test.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realRepoNs from "../../../db/repositories/agent-sandboxes";
import * as realSchemaNs from "../../../db/schemas/agent-sandboxes";
import * as realLoggerNs from "../../utils/logger";
import * as realSandboxNs from "../eliza-sandbox";

// Snapshot real module records before mock.module rewires them, and restore in
// afterAll: Bun runs every cloud-shared test file in one process with no
// per-file mock teardown, so an un-restored stub leaks into later files.
const realRepo = { ...realRepoNs };
const realSchema = { ...realSchemaNs };
const realLogger = { ...realLoggerNs };
const realSandbox = { ...realSandboxNs };

const WARM_POOL_ORG_ID = "warm-pool-sentinel-org";

const repo = {
  createPoolEntry: mock(),
  update: mock(),
  markPoolEntryReady: mock(),
  findById: mock(),
  deletePoolEntry: mock(),
};

const sandbox = {
  provision: mock(),
  deleteAgent: mock(),
};

mock.module("../../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: repo,
}));
mock.module("../../../db/schemas/agent-sandboxes", () => ({ WARM_POOL_ORG_ID }));
mock.module("../eliza-sandbox", () => ({ elizaSandboxService: sandbox }));
mock.module("../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { getHetznerPoolContainerCreator } = await import("./agent-warm-pool-creator");

const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const m of [...Object.values(repo), ...Object.values(sandbox)]) m.mockReset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.module("../../../db/repositories/agent-sandboxes", () => realRepo);
  mock.module("../../../db/schemas/agent-sandboxes", () => realSchema);
  mock.module("../eliza-sandbox", () => realSandbox);
  mock.module("../../utils/logger", () => realLogger);
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// destroyPoolContainer — internal failure PROPAGATES, designed no-op stays distinct
// ---------------------------------------------------------------------------

describe("destroyPoolContainer fail-closed", () => {
  test("a DB error on the final deletePoolEntry PROPAGATES — not swallowed into a phantom leaked row", async () => {
    repo.findById.mockResolvedValue({ id: "p1", organization_id: WARM_POOL_ORG_ID });
    sandbox.deleteAgent.mockResolvedValue({ success: true });
    // The removed slop was `.catch(() => undefined)` here: a genuine DB failure
    // would read as a successful destroy while the pool row leaks. It must throw.
    repo.deletePoolEntry.mockRejectedValue(new Error("connection terminated"));

    const creator = getHetznerPoolContainerCreator();
    await expect(creator.destroyPoolContainer("p1")).rejects.toThrow("connection terminated");
  });

  test("row already gone (deletePoolEntry returns false) resolves — a designed idempotent no-op, not a failure", async () => {
    repo.findById.mockResolvedValue({ id: "p2", organization_id: WARM_POOL_ORG_ID });
    sandbox.deleteAgent.mockResolvedValue({ success: true });
    repo.deletePoolEntry.mockResolvedValue(false);

    const creator = getHetznerPoolContainerCreator();
    await expect(creator.destroyPoolContainer("p2")).resolves.toBeUndefined();
    expect(repo.deletePoolEntry).toHaveBeenCalledWith("p2");
  });

  test("unknown poolId (findById null) is an idempotent no-op — no destroy attempted", async () => {
    repo.findById.mockResolvedValue(null);
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.destroyPoolContainer("gone")).resolves.toBeUndefined();
    expect(sandbox.deleteAgent).not.toHaveBeenCalled();
    expect(repo.deletePoolEntry).not.toHaveBeenCalled();
  });

  test("refuses to destroy a non-pool sandbox — throws the ownership guard, never deletes", async () => {
    repo.findById.mockResolvedValue({ id: "user-owned", organization_id: "some-user-org" });
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.destroyPoolContainer("user-owned")).rejects.toThrow(
      /refusing to destroy non-pool sandbox/,
    );
    expect(sandbox.deleteAgent).not.toHaveBeenCalled();
    expect(repo.deletePoolEntry).not.toHaveBeenCalled();
  });

  test("deleteAgent real failure PROPAGATES — the row is never deleted afterward", async () => {
    repo.findById.mockResolvedValue({ id: "p3", organization_id: WARM_POOL_ORG_ID });
    sandbox.deleteAgent.mockResolvedValue({ success: false, error: "hetzner 500" });
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.destroyPoolContainer("p3")).rejects.toThrow(
      /pool destroy failed: hetzner 500/,
    );
    expect(repo.deletePoolEntry).not.toHaveBeenCalled();
  });

  test('"Agent not found" from deleteAgent is a designed 404-as-success — proceeds to reap the row', async () => {
    repo.findById.mockResolvedValue({ id: "p4", organization_id: WARM_POOL_ORG_ID });
    sandbox.deleteAgent.mockResolvedValue({ success: false, error: "Agent not found" });
    repo.deletePoolEntry.mockResolvedValue(true);
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.destroyPoolContainer("p4")).resolves.toBeUndefined();
    expect(repo.deletePoolEntry).toHaveBeenCalledWith("p4");
  });
});

// ---------------------------------------------------------------------------
// createPoolContainer — failed provision throws, never fabricates a pool id
// ---------------------------------------------------------------------------

describe("createPoolContainer fail-closed", () => {
  test("provision failure marks the row 'error' and THROWS — no fabricated ready pool entry", async () => {
    repo.createPoolEntry.mockResolvedValue({ id: "row-1" });
    sandbox.provision.mockResolvedValue({ success: false, error: "no capacity" });

    const creator = getHetznerPoolContainerCreator();
    await expect(creator.createPoolContainer("img:latest")).rejects.toThrow(
      /pool provision failed: no capacity/,
    );
    expect(repo.update).toHaveBeenCalledWith("row-1", {
      status: "error",
      error_message: "no capacity",
    });
    expect(repo.markPoolEntryReady).not.toHaveBeenCalled();
  });

  test("successful provision returns the real id + nodeId — the healthy path stays intact", async () => {
    repo.createPoolEntry.mockResolvedValue({ id: "row-2" });
    sandbox.provision.mockResolvedValue({ success: true, sandboxRecord: { node_id: "node-9" } });
    repo.markPoolEntryReady.mockResolvedValue({ node_id: "node-9", bridge_url: "http://x" });

    const creator = getHetznerPoolContainerCreator();
    await expect(creator.createPoolContainer("img:latest")).resolves.toEqual({
      id: "row-2",
      nodeId: "node-9",
    });
  });
});

// ---------------------------------------------------------------------------
// healthProbe — unreachable ⇒ designed `false`, distinct from `true` alive
// ---------------------------------------------------------------------------

describe("healthProbe designed-false vs alive", () => {
  test("fetch throwing (network/abort) yields a distinguishable false — reaped, never a thrown crash", async () => {
    repo.findById.mockResolvedValue({ health_url: "http://dead/health" });
    globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.healthProbe("p1")).resolves.toBe(false);
  });

  test("a 200 response reports alive (true) — distinct from the unreachable-false above", async () => {
    repo.findById.mockResolvedValue({ health_url: "http://ok/health" });
    globalThis.fetch = mock(() => Promise.resolve({ ok: true } as Response)) as typeof fetch;
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.healthProbe("p1")).resolves.toBe(true);
  });

  test("a row with no health_url is not-alive (false) without any fetch attempt", async () => {
    repo.findById.mockResolvedValue({ health_url: null });
    const fetchSpy = mock(() => Promise.resolve({ ok: true } as Response));
    globalThis.fetch = fetchSpy as typeof fetch;
    const creator = getHetznerPoolContainerCreator();
    await expect(creator.healthProbe("p1")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

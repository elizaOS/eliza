/**
 * Error-policy proof for the drain/deprovision path (#13415). A failed outbound
 * Hetzner `deleteServer` must PROPAGATE — fail closed, DB row kept — so a live,
 * still-billing server is never orphaned by a silently-dropped delete; while an
 * idempotent 404 ("already gone", the desired end state) stays a distinct,
 * designed success that removes the DB row. Deterministic: the compute provider
 * and all repositories are injected/mocked, no live cloud API.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "../../../db/repositories/docker-nodes";
import * as realDockerNodesNs from "../../../db/repositories/docker-nodes";
import * as realDockerNodeWorkloadsNs from "../docker-node-workloads";
import type { ComputeProvider } from "./compute-provider";
import * as realHetznerCloudApiNs from "./hetzner-cloud-api";
import * as realNodeBootstrapNs from "./node-bootstrap";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realHetznerCloudApi = { ...realHetznerCloudApiNs };
const realNodeBootstrap = { ...realNodeBootstrapNs };
const originalFirewallIds = process.env.CONTAINERS_HCLOUD_FIREWALL_IDS;
const originalEnvironment = process.env.ENVIRONMENT;

// The source narrows the swallow to `err instanceof HetznerCloudError &&
// err.code === "not_found"`, so the thrown error must be an instance of the
// SAME class the module-under-test imports — i.e. this mocked one.
class FakeHetznerCloudError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HetznerCloudError";
  }
}

const mocks = {
  findByNodeId: mock(),
  findAll: mock(),
  requestDeprovision: mock(),
  updateNode: mock(),
  deleteNode: mock(),
  countRetained: mock(),
  isConfigured: mock(),
  getServer: mock(),
  deleteServer: mock(),
};

mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findByNodeId: mocks.findByNodeId,
    findAll: mocks.findAll,
    requestAutoscaleDeprovision: mocks.requestDeprovision,
    update: mocks.updateNode,
    delete: mocks.deleteNode,
  },
}));

mock.module("../docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mock(async () => 0),
  countRetainedWorkloadsOnNode: mocks.countRetained,
}));

mock.module("./hetzner-cloud-api", () => ({
  HetznerCloudError: FakeHetznerCloudError,
  getHetznerCloudClient: () => ({
    getServer: mocks.getServer,
    deleteServer: mocks.deleteServer,
  }),
  isHetznerCloudConfigured: mocks.isConfigured,
}));

mock.module("./node-bootstrap", () => ({
  buildContainerNodeUserData: mock(() => "#cloud-config\n"),
}));

afterAll(() => {
  mock.module("../../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("../docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./hetzner-cloud-api", () => realHetznerCloudApi);
  mock.module("./node-bootstrap", () => realNodeBootstrap);
  if (originalFirewallIds === undefined) delete process.env.CONTAINERS_HCLOUD_FIREWALL_IDS;
  else process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = originalFirewallIds;
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
});

const NODE_ID = "drain-node";
const HCLOUD_SERVER_ID = 4242;

function makeNode(): DockerNode {
  return {
    id: "db-1",
    node_id: NODE_ID,
    hostname: "203.0.113.9",
    ssh_port: 22,
    ssh_user: "root",
    capacity: 8,
    allocated_count: 0,
    // Already disabled so drain skips the enable→disable update and goes
    // straight to the deprovision branch under test.
    enabled: false,
    status: "healthy",
    metadata: {
      provider: "hetzner-cloud",
      autoscaled: true,
      hcloudServerId: HCLOUD_SERVER_ID,
      environment: "local",
    },
    fleet_kind: "cloud",
    infrastructure_provider: "hetzner",
    provider_server_id: String(HCLOUD_SERVER_ID),
    created_at: new Date("2026-05-15T12:00:00Z"),
    updated_at: new Date("2026-05-15T12:00:00Z"),
  } as DockerNode;
}

// Inject a ComputeProvider whose only exercised method is deleteServer — the
// documented constructor seam (#8919) — so drainNode routes deletes to it.
const provider = {
  getServer: mocks.getServer,
  deleteServer: mocks.deleteServer,
} as unknown as ComputeProvider;

async function drainDeprovision(): Promise<void> {
  const { NodeAutoscaler } = await import("./node-autoscaler");
  const autoscaler = new NodeAutoscaler(undefined, undefined, provider);
  await autoscaler.drainNode(NODE_ID, { deprovision: true });
}

describe("NodeAutoscaler drain deprovision — fail-closed error policy (#13415)", () => {
  beforeEach(() => {
    mocks.findByNodeId.mockReset();
    mocks.findAll.mockReset();
    mocks.requestDeprovision.mockReset();
    mocks.requestDeprovision.mockResolvedValue(makeNode());
    mocks.updateNode.mockReset();
    mocks.deleteNode.mockReset();
    mocks.countRetained.mockReset();
    mocks.isConfigured.mockReset();
    mocks.getServer.mockReset();
    mocks.deleteServer.mockReset();

    mocks.findByNodeId.mockResolvedValue(makeNode());
    mocks.updateNode.mockResolvedValue(true);
    mocks.deleteNode.mockResolvedValue(true);
    mocks.countRetained.mockResolvedValue(0);
    mocks.isConfigured.mockReturnValue(true);
    process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = "8101,8102";
    process.env.ENVIRONMENT = "local";
    mocks.getServer.mockResolvedValue({
      id: HCLOUD_SERVER_ID,
      name: NODE_ID,
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": NODE_ID,
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [
        { id: 8101, status: "applied" },
        { id: 8102, status: "applied" },
      ],
    });
  });

  test("a later autoscale cycle retries failed deletion without selecting an operator-disabled node", async () => {
    const node = { ...makeNode(), enabled: true };
    const operatorDisabled = {
      ...makeNode(),
      id: "operator-disabled-row",
      node_id: "operator-disabled",
    };
    let rows = [node, operatorDisabled];
    mocks.findByNodeId.mockImplementation(
      async (id: string) => rows.find((row) => row.node_id === id) ?? null,
    );
    mocks.findAll.mockImplementation(async () => rows);
    mocks.updateNode.mockImplementation(async (id: string, patch: Partial<DockerNode>) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    });
    mocks.requestDeprovision.mockImplementation(async (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      row.enabled = false;
      row.metadata = { ...row.metadata, autoscaleDeprovisionRequested: true };
      return row;
    });
    mocks.deleteNode.mockImplementation(async (id: string) => {
      rows = rows.filter((row) => row.id !== id);
      return true;
    });
    mocks.deleteServer.mockRejectedValueOnce(new Error("temporary provider outage"));
    mocks.deleteServer.mockResolvedValueOnce(undefined);
    const { NodeAutoscaler, DEFAULT_AUTOSCALE_POLICY } = await import("./node-autoscaler");
    const newCycle = () =>
      new NodeAutoscaler(
        { ...DEFAULT_AUTOSCALE_POLICY, minFreeSlotsBuffer: 0, minHotAvailableSlots: 0 },
        () => Date.parse("2026-05-15T13:00:00Z"),
        provider,
      );

    await expect(newCycle().drainNode(NODE_ID, { deprovision: true })).rejects.toThrow(
      "temporary provider outage",
    );
    expect(node.enabled).toBe(false);
    expect(rows).toHaveLength(2);

    // A fresh scheduler instance must discover the pending provider effect
    // from persisted state, without treating every operator cordon as deletion.
    const decision = await newCycle().evaluateCapacity();
    expect(decision.shouldScaleUp).toBe(false);
    expect(decision.shouldScaleDownNodeIds).toEqual([NODE_ID]);
    await newCycle().drainNode(decision.shouldScaleDownNodeIds[0]!, { deprovision: true });
    expect(mocks.deleteServer).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.node_id)).toEqual(["operator-disabled"]);
  });

  test("a pending deprovision never bypasses retained workloads", async () => {
    const node = makeNode();
    node.metadata.autoscaleDeprovisionRequested = true;
    mocks.findAll.mockResolvedValue([node]);
    mocks.countRetained.mockResolvedValue(1);
    const { NodeAutoscaler, DEFAULT_AUTOSCALE_POLICY } = await import("./node-autoscaler");
    const autoscaler = new NodeAutoscaler(
      { ...DEFAULT_AUTOSCALE_POLICY, minFreeSlotsBuffer: 0, minHotAvailableSlots: 0 },
      undefined,
      provider,
    );
    expect((await autoscaler.evaluateCapacity()).shouldScaleDownNodeIds).toEqual([]);
    await autoscaler.drainNode(NODE_ID, { deprovision: true });
    expect(mocks.deleteServer).not.toHaveBeenCalled();
    expect(mocks.deleteNode).not.toHaveBeenCalled();
  });

  test("does not issue provider deletion when durable drain intent cannot be saved", async () => {
    mocks.requestDeprovision.mockRejectedValue(new Error("database unavailable"));
    await expect(drainDeprovision()).rejects.toThrow("database unavailable");
    expect(mocks.deleteServer).not.toHaveBeenCalled();
    expect(mocks.deleteNode).not.toHaveBeenCalled();
  });

  test("propagates a typed Hetzner API failure and KEEPS the DB row (no orphaned server)", async () => {
    mocks.deleteServer.mockRejectedValue(
      new FakeHetznerCloudError("rate_limit_exceeded", "429 from Hetzner"),
    );

    await expect(drainDeprovision()).rejects.toMatchObject({
      code: "rate_limit_exceeded",
    });

    // The delete failed → the node row must remain so a later drain retries.
    expect(mocks.deleteServer).toHaveBeenCalledWith(HCLOUD_SERVER_ID);
    expect(mocks.deleteNode).not.toHaveBeenCalled();
  });

  test("propagates a generic (non-typed) transport failure and KEEPS the DB row", async () => {
    mocks.deleteServer.mockRejectedValue(new Error("ECONNRESET"));

    await expect(drainDeprovision()).rejects.toThrow("ECONNRESET");

    expect(mocks.deleteNode).not.toHaveBeenCalled();
  });

  test("treats an idempotent not_found as designed success and removes the DB row", async () => {
    mocks.deleteServer.mockRejectedValue(
      new FakeHetznerCloudError("not_found", "server already deleted"),
    );

    await expect(drainDeprovision()).resolves.toBeUndefined();

    // 404 = already deprovisioned (desired end state) → the row is cleaned up,
    // distinct from the failure paths above which retain it.
    expect(mocks.deleteServer).toHaveBeenCalledWith(HCLOUD_SERVER_ID);
    expect(mocks.deleteNode).toHaveBeenCalledTimes(1);
    expect(mocks.deleteNode).toHaveBeenCalledWith("db-1");
  });

  test("a clean delete removes the DB row (baseline distinct from failure)", async () => {
    mocks.deleteServer.mockResolvedValue(undefined);

    await expect(drainDeprovision()).resolves.toBeUndefined();

    expect(mocks.deleteNode).toHaveBeenCalledTimes(1);
    expect(mocks.deleteNode).toHaveBeenCalledWith("db-1");
  });

  test("does not delete when provider read-back returns a different server ID", async () => {
    mocks.getServer.mockResolvedValueOnce({
      id: 9999,
      name: NODE_ID,
      status: "running",
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": NODE_ID,
        environment: "local",
        tier: "data-plane",
      },
      firewallAttachments: [
        { id: 8101, status: "applied" },
        { id: 8102, status: "applied" },
      ],
    });

    await expect(drainDeprovision()).rejects.toThrow(
      "returned server 9999 for requested server 4242",
    );
    expect(mocks.deleteServer).not.toHaveBeenCalled();
    expect(mocks.deleteNode).not.toHaveBeenCalled();
  });
});

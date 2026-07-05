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
  updateNode: mock(),
  deleteNode: mock(),
  countRetained: mock(),
  isConfigured: mock(),
  deleteServer: mock(),
};

mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findByNodeId: mocks.findByNodeId,
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
  getHetznerCloudClient: () => ({ deleteServer: mocks.deleteServer }),
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
    },
    created_at: new Date("2026-05-15T12:00:00Z"),
    updated_at: new Date("2026-05-15T12:00:00Z"),
  } as DockerNode;
}

// Inject a ComputeProvider whose only exercised method is deleteServer — the
// documented constructor seam (#8919) — so drainNode routes deletes to it.
const provider = { deleteServer: mocks.deleteServer } as unknown as ComputeProvider;

async function drainDeprovision(): Promise<void> {
  const { NodeAutoscaler } = await import("./node-autoscaler");
  const autoscaler = new NodeAutoscaler(undefined, undefined, provider);
  await autoscaler.drainNode(NODE_ID, { deprovision: true });
}

describe("NodeAutoscaler drain deprovision — fail-closed error policy (#13415)", () => {
  beforeEach(() => {
    mocks.findByNodeId.mockReset();
    mocks.updateNode.mockReset();
    mocks.deleteNode.mockReset();
    mocks.countRetained.mockReset();
    mocks.isConfigured.mockReset();
    mocks.deleteServer.mockReset();

    mocks.findByNodeId.mockResolvedValue(makeNode());
    mocks.updateNode.mockResolvedValue(true);
    mocks.deleteNode.mockResolvedValue(true);
    mocks.countRetained.mockResolvedValue(0);
    mocks.isConfigured.mockReturnValue(true);
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
});

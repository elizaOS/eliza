// Exercises node autoscaler behavior with deterministic cloud-shared lib fixtures.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "../../../db/repositories/docker-nodes";

// Bun runs every cloud-shared test file in a single process, and `mock.module`
// overrides are process-global with no built-in per-file teardown. Without an
// explicit restore, these stubs leak into later files that import the real
// modules (e.g. `compute-provider-characterization.test.ts` reading
// `HetznerCloudError.status`), producing order-dependent failures. Capture the
// real modules up front and re-install them in `afterAll`.
import * as realDockerNodesNs from "../../../db/repositories/docker-nodes";
import * as realDockerNodeWorkloadsNs from "../docker-node-workloads";
import * as realHetznerCloudApiNs from "./hetzner-cloud-api";
import * as realNodeBootstrapNs from "./node-bootstrap";

// Snapshot the real exports into plain objects *before* the `mock.module` calls
// below run. The `import * as` namespaces are live bindings — once `mock.module`
// replaces a module record, the namespace reflects the stub — so we copy the
// exports eagerly at module-evaluation time (imports are hoisted above the
// `mock.module` statements) and restore from these snapshots in `afterAll`.
const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realHetznerCloudApi = { ...realHetznerCloudApiNs };
const realNodeBootstrap = { ...realNodeBootstrapNs };

const AGENT_IMAGE = "ELIZA_AGENT_IMAGE";
const AGENT_IMAGE_PLATFORM = "ELIZA_AGENT_IMAGE_PLATFORM";
const HCLOUD_NETWORK_IDS = "CONTAINERS_HCLOUD_NETWORK_IDS";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

const mocks = {
  nodes: [] as DockerNode[],
  createNode: mock(),
  findAllNodes: mock(),
  createServer: mock(),
  deleteServer: mock(),
  isConfigured: mock(),
  buildUserData: mock(),
  countAllocated: mock(),
  countRetained: mock(),
  findByNodeId: mock(),
  updateNode: mock(),
  deleteNode: mock(),
};

mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findAll: mocks.findAllNodes,
    findByNodeId: mocks.findByNodeId,
    create: mocks.createNode,
    update: mocks.updateNode,
    delete: mocks.deleteNode,
  },
}));

mock.module("../docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mocks.countAllocated,
  countRetainedWorkloadsOnNode: mocks.countRetained,
}));

mock.module("./hetzner-cloud-api", () => ({
  HetznerCloudError: class HetznerCloudError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "HetznerCloudError";
    }
  },
  getHetznerCloudClient: () => ({
    createServer: mocks.createServer,
    deleteServer: mocks.deleteServer,
  }),
  isHetznerCloudConfigured: mocks.isConfigured,
}));

mock.module("./node-bootstrap", () => ({
  buildContainerNodeUserData: mocks.buildUserData,
}));

afterAll(() => {
  mock.module("../../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("../docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./hetzner-cloud-api", () => realHetznerCloudApi);
  mock.module("./node-bootstrap", () => realNodeBootstrap);
});

import { InMemoryComputeProvider } from "./compute-provider-fake";
import { type AutoscalePolicy, NodeAutoscaler } from "./node-autoscaler";

const policy: AutoscalePolicy = {
  minFreeSlotsBuffer: 4,
  minHotAvailableSlots: 1,
  maxNodes: 4,
  scaleUpCooldownMs: 5 * 60 * 1000,
  idleNodeMinAgeMs: 30 * 60 * 1000,
  defaultServerType: "cax21",
  defaultLocation: "fsn1",
  defaultImage: "ubuntu-24.04",
  defaultCapacity: 8,
};

describe("NodeAutoscaler Hetzner provisioning", () => {
  let originalAgentImage: string | undefined;
  let originalAgentImagePlatform: string | undefined;
  let originalHcloudNetworkIds: string | undefined;

  beforeEach(() => {
    originalAgentImage = process.env[AGENT_IMAGE];
    originalAgentImagePlatform = process.env[AGENT_IMAGE_PLATFORM];
    originalHcloudNetworkIds = process.env[HCLOUD_NETWORK_IDS];
    process.env[AGENT_IMAGE] = "ghcr.io/elizaos/eliza:latest";
    process.env[AGENT_IMAGE_PLATFORM] = "linux/arm64";
    delete process.env[HCLOUD_NETWORK_IDS];
    mocks.createNode.mockClear();
    mocks.findAllNodes.mockClear();
    mocks.createServer.mockClear();
    mocks.deleteServer.mockClear();
    mocks.isConfigured.mockClear();
    mocks.buildUserData.mockClear();
    mocks.countAllocated.mockClear();
    mocks.countRetained.mockClear();
    mocks.nodes = [];
    mocks.findAllNodes.mockImplementation(() => Promise.resolve(mocks.nodes));
    mocks.countAllocated.mockResolvedValue(0);
    mocks.countRetained.mockResolvedValue(0);
    mocks.isConfigured.mockReturnValue(true);
    mocks.buildUserData.mockReturnValue("#cloud-config\n");
    mocks.createServer.mockResolvedValue({
      server: {
        id: 4242,
        name: "node-test",
        // The Hetzner client now collapses public_net onto the canonical seam
        // field; the autoscaler reads publicIpv4 (not provider-specific shapes).
        publicIpv4: "203.0.113.10",
        public_net: {
          ipv4: { ip: "203.0.113.10" },
          ipv6: null,
        },
      },
      rootPassword: "root-secret",
    });
  });

  afterEach(() => {
    restoreEnv(AGENT_IMAGE, originalAgentImage);
    restoreEnv(AGENT_IMAGE_PLATFORM, originalAgentImagePlatform);
    restoreEnv(HCLOUD_NETWORK_IDS, originalHcloudNetworkIds);
  });

  test("creates a Hetzner server and registers the autoscaled docker node", async () => {
    const autoscaler = new NodeAutoscaler(policy, () => Date.parse("2026-05-15T12:00:00Z"));

    const result = await autoscaler.provisionNode(
      {
        nodeId: "node-test",
        capacity: 6,
        labels: { purpose: "onboarding-e2e" },
        prePullImages: ["ghcr.io/elizaos/eliza:test"],
      },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    expect(mocks.buildUserData).toHaveBeenCalledWith({
      nodeId: "node-test",
      controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
      registrationUrl: "https://cloud.example.test/register",
      registrationSecret: "secret",
      prePullImages: ["ghcr.io/elizaos/eliza:test"],
      prePullPlatform: "linux/arm64",
      capacity: 6,
    });
    expect(mocks.createServer).toHaveBeenCalledWith({
      name: "node-test",
      serverType: "cax21",
      location: "fsn1",
      image: "ubuntu-24.04",
      userData: "#cloud-config\n",
      networkIds: [],
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-test",
        environment: "local",
        tier: "data-plane",
        purpose: "onboarding-e2e",
      },
    });
    expect(mocks.createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "node-test",
        hostname: "203.0.113.10",
        capacity: 6,
        enabled: true,
        status: "unknown",
        ssh_user: "root",
        metadata: expect.objectContaining({
          provider: "hetzner-cloud",
          autoscaled: true,
          hcloudServerId: 4242,
          serverType: "cax21",
          location: "fsn1",
          image: "ubuntu-24.04",
          architecture: "arm64",
        }),
      }),
    );
    expect(result).toEqual({
      nodeId: "node-test",
      hostname: "203.0.113.10",
      hcloudServerId: 4242,
      rootPassword: "root-secret",
    });
  });

  test("passes configured Hetzner private network ids to new nodes", async () => {
    process.env[HCLOUD_NETWORK_IDS] = "12305703";
    const autoscaler = new NodeAutoscaler(policy);

    await autoscaler.provisionNode(
      { nodeId: "node-networked" },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "node-networked",
        networkIds: [12305703],
      }),
    );
  });

  test("fails before calling hcloud when Hetzner is not configured", async () => {
    mocks.isConfigured.mockReturnValue(false);
    const autoscaler = new NodeAutoscaler(policy);

    await expect(
      autoscaler.provisionNode(
        { nodeId: "node-test" },
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      ),
    ).rejects.toMatchObject({
      code: "missing_token",
    });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();
  });

  test("generates an eliza-core-<8hex> nodeId when none is supplied", async () => {
    const autoscaler = new NodeAutoscaler(policy);
    mocks.createServer.mockResolvedValue({
      server: {
        id: 7777,
        name: "generated",
        public_net: { ipv4: { ip: "203.0.113.20" }, ipv6: null },
      },
      rootPassword: null,
    });

    const result = await autoscaler.provisionNode(
      {},
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    const idPattern = /^eliza-core-[0-9a-f]{8}$/;
    expect(result.nodeId).toMatch(idPattern);
    expect(mocks.buildUserData.mock.calls[0]?.[0]?.nodeId).toBe(result.nodeId);
    expect(mocks.createServer.mock.calls[0]?.[0]?.name).toBe(result.nodeId);
    expect(mocks.createServer.mock.calls[0]?.[0]?.labels?.["node-id"]).toBe(result.nodeId);
    expect(mocks.createNode.mock.calls[0]?.[0]?.node_id).toBe(result.nodeId);
  });

  test("generated nodeIds are unique across repeated provisions", async () => {
    const autoscaler = new NodeAutoscaler(policy);
    const seen = new Set<string>();
    const N = 50;

    for (let i = 0; i < N; i++) {
      mocks.createNode.mockClear();
      mocks.createServer.mockResolvedValue({
        server: {
          id: 8000 + i,
          name: "generated",
          public_net: { ipv4: { ip: "203.0.113.30" }, ipv6: null },
        },
        rootPassword: null,
      });
      const result = await autoscaler.provisionNode(
        {},
        {
          controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
          registrationUrl: "https://cloud.example.test/register",
          registrationSecret: "secret",
        },
      );
      expect(result.nodeId).toMatch(/^eliza-core-[0-9a-f]{8}$/);
      seen.add(result.nodeId);
    }

    expect(seen.size).toBe(N);
  });

  test("scales up when there is no healthy compatible capacity", async () => {
    const autoscaler = new NodeAutoscaler(policy);

    await expect(autoscaler.evaluateCapacity()).resolves.toMatchObject({
      totalCapacity: 0,
      totalAllocated: 0,
      totalAvailable: 0,
      enabledNodeCount: 0,
      healthyNodeCount: 0,
      shouldScaleUp: true,
      reason: "available 0 < hot floor 1",
    });
  });

  // #8919: the autoscaler resolves its provider via the ComputeProvider seam, so
  // a fake can be injected directly — no monkey-patching of getHetznerCloudClient.
  test("provisions through an injected ComputeProvider without monkey-patching (#8919)", async () => {
    const fake = new InMemoryComputeProvider({ serverActivateAfterTicks: 0 });
    const autoscaler = new NodeAutoscaler(policy, () => Date.parse("2026-05-15T12:00:00Z"), fake);

    const result = await autoscaler.provisionNode(
      { nodeId: "seam-node", capacity: 4, prePullImages: [] },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );

    // The injected fake handled createServer — the module-mocked Hetzner client
    // was bypassed entirely.
    expect(mocks.createServer).not.toHaveBeenCalled();
    const servers = await fake.listServers();
    expect(servers.some((s) => s.name === "seam-node")).toBe(true);

    // The docker node is registered with the seam's canonical publicIpv4
    // (the fake assigns 10.0.0.<id> once active), not a provider-specific shape.
    expect(result.nodeId).toBe("seam-node");
    expect(result.hostname).toMatch(/^10\.0\.0\./);
    expect(mocks.createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: "seam-node",
        hostname: result.hostname,
      }),
    );
  });
});

describe("NodeAutoscaler full provision\u2192healthy\u2192drain loop (#8920)", () => {
  const CREATED_AT = Date.parse("2026-05-15T12:00:00Z");
  // 1h after creation \u2192 safely past scaleUpCooldownMs (5m) and idleNodeMinAgeMs (30m).
  const NOW = CREATED_AT + 60 * 60 * 1000;
  let store: DockerNode[];
  let idSeq: number;
  let originalAgentImage: string | undefined;
  let originalAgentImagePlatform: string | undefined;

  beforeEach(() => {
    originalAgentImage = process.env[AGENT_IMAGE];
    originalAgentImagePlatform = process.env[AGENT_IMAGE_PLATFORM];
    process.env[AGENT_IMAGE] = "ghcr.io/elizaos/eliza:latest";
    process.env[AGENT_IMAGE_PLATFORM] = "linux/arm64";
    store = [];
    idSeq = 1;
    mocks.buildUserData.mockReturnValue("#cloud-config\n");
    mocks.countAllocated.mockResolvedValue(0);
    mocks.countRetained.mockResolvedValue(0);
    mocks.isConfigured.mockReturnValue(true);
    mocks.findAllNodes.mockImplementation(() => Promise.resolve(store.slice()));
    mocks.findByNodeId.mockImplementation((nodeId: string) =>
      Promise.resolve(store.find((n) => n.node_id === nodeId) ?? null),
    );
    mocks.createNode.mockImplementation((row: Partial<DockerNode>) => {
      const node = {
        id: `db-${idSeq++}`,
        created_at: new Date(CREATED_AT),
        updated_at: new Date(CREATED_AT),
        ...row,
      } as DockerNode;
      store.push(node);
      return Promise.resolve(node);
    });
    mocks.updateNode.mockImplementation((id: string, patch: Partial<DockerNode>) => {
      const node = store.find((n) => n.id === id);
      if (node) Object.assign(node, patch);
      return Promise.resolve(true);
    });
    mocks.deleteNode.mockImplementation((id: string) => {
      const idx = store.findIndex((n) => n.id === id);
      if (idx >= 0) store.splice(idx, 1);
      return Promise.resolve(true);
    });
  });

  afterEach(() => {
    restoreEnv(AGENT_IMAGE, originalAgentImage);
    restoreEnv(AGENT_IMAGE_PLATFORM, originalAgentImagePlatform);
    mocks.createNode.mockReset();
    mocks.findAllNodes.mockReset();
    mocks.findByNodeId.mockReset();
    mocks.updateNode.mockReset();
    mocks.deleteNode.mockReset();
  });

  test("drives provision \u2192 healthy \u2192 drain against an injected ComputeProvider + stateful docker_nodes", async () => {
    const fake = new InMemoryComputeProvider({ serverActivateAfterTicks: 1 });
    const autoscaler = new NodeAutoscaler(policy, () => NOW, fake);

    // 1. Empty pool \u2192 the loop wants to scale up.
    const empty = await autoscaler.evaluateCapacity();
    expect(empty.healthyNodeCount).toBe(0);
    expect(empty.shouldScaleUp).toBe(true);

    // 2. Provision. The injected fake handles createServer (the module-mocked
    //    Hetzner client stays untouched); the row lands in `unknown` status.
    const provisioned = await autoscaler.provisionNode(
      { nodeId: "loop-node", capacity: 8, prePullImages: [] },
      {
        controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
        registrationUrl: "https://cloud.example.test/register",
        registrationSecret: "secret",
      },
    );
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
    expect(store[0].status).toBe("unknown");
    const serverId = provisioned.hcloudServerId as number;
    expect(serverId).toBeGreaterThan(0);
    expect((await fake.getServer(serverId))?.status).toBe("new");

    // 3. An `unknown` node contributes no healthy capacity yet \u2192 still scaling up.
    const booting = await autoscaler.evaluateCapacity();
    expect(booting.healthyNodeCount).toBe(0);
    expect(booting.shouldScaleUp).toBe(true);

    // 4. The server boots (tick advances the action clock) and the periodic
    //    health check flips the docker_nodes row to `healthy`.
    fake.tick(1);
    expect((await fake.getServer(serverId))?.status).toBe("active");
    store[0].status = "healthy";

    // 5. The node now serves its full capacity \u2192 no more scale-up.
    const healthy = await autoscaler.evaluateCapacity();
    expect(healthy.healthyNodeCount).toBe(1);
    expect(healthy.totalCapacity).toBe(8);
    expect(healthy.shouldScaleUp).toBe(false);

    // 6. Drain + deprovision: the node leaves the pool and the underlying server
    //    is destroyed through the same seam.
    await autoscaler.drainNode("loop-node", { deprovision: true });
    expect(store).toHaveLength(0);
    expect(await fake.getServer(serverId)).toBeNull();

    // 7. Back to an empty pool \u2192 the loop is ready to scale up again.
    const drained = await autoscaler.evaluateCapacity();
    expect(drained.healthyNodeCount).toBe(0);
    expect(drained.shouldScaleUp).toBe(true);
  });
});

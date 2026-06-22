import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "../../../db/repositories/docker-nodes";
// Bun runs every cloud-shared test file in a single process, and `mock.module`
// overrides are process-global with no built-in per-file teardown. Without an
// explicit restore, these stubs leak into later files that import the real
// modules, producing order-dependent failures. Capture the real modules up
// front and re-install them in `afterAll`.
//
// NOTE: after the #8919 ComputeProvider-seam refactor we no longer mock
// `./hetzner-cloud-api` at all — the autoscaler resolves its provider through an
// injected `deps.provider` (the seam), so the fake is passed directly into the
// constructor with NO monkey-patching of the provider singletons. We still mock
// the DB repository, the workload counters, and node-bootstrap because those are
// process-global collaborators the autoscaler reads directly.
import * as realDockerNodesNs from "../../../db/repositories/docker-nodes";
import * as realDockerNodeWorkloadsNs from "../docker-node-workloads";
import type { ComputeProvider, ProvisionedServer } from "./compute-provider";
import * as realNodeBootstrapNs from "./node-bootstrap";

// Snapshot the real exports into plain objects *before* the `mock.module` calls
// below run. The `import * as` namespaces are live bindings — once `mock.module`
// replaces a module record, the namespace reflects the stub — so we copy the
// exports eagerly at module-evaluation time (imports are hoisted above the
// `mock.module` statements) and restore from these snapshots in `afterAll`.
const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
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
  buildUserData: mock(),
  countAllocated: mock(),
  countRetained: mock(),
};

/** Tracks whether the injected provider reports its surface as configured. */
let providerConfigured = true;

mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findAll: mocks.findAllNodes,
    findByNodeId: mock(),
    create: mocks.createNode,
    update: mock(),
    delete: mock(),
  },
}));

mock.module("../docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mocks.countAllocated,
  countRetainedWorkloadsOnNode: mocks.countRetained,
}));

mock.module("./node-bootstrap", () => ({
  buildContainerNodeUserData: mocks.buildUserData,
}));

afterAll(() => {
  mock.module("../../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("../docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./node-bootstrap", () => realNodeBootstrap);
});

import { type AutoscalePolicy, NodeAutoscaler, type NodeAutoscalerDeps } from "./node-autoscaler";

/**
 * Minimal `ComputeProvider` test double wired to the spy mocks. Only the two
 * methods the autoscaler actually drives (`createServer` / `deleteServer`) carry
 * behavior; the rest throw if the autoscaler ever reaches for them, which would
 * be a regression.
 */
function fakeProvider(): ComputeProvider {
  const unexpected = (name: string) => () => {
    throw new Error(`fakeProvider.${name} should not be called by the autoscaler`);
  };
  return {
    createServer: (input) => mocks.createServer(input) as Promise<ProvisionedServer>,
    deleteServer: (id) => mocks.deleteServer(id) as Promise<void>,
    listServers: unexpected("listServers"),
    getServer: unexpected("getServer"),
    powerOff: unexpected("powerOff"),
    powerOn: unexpected("powerOn"),
    listVolumes: unexpected("listVolumes"),
    getVolume: unexpected("getVolume"),
    createVolume: unexpected("createVolume"),
    attachVolume: unexpected("attachVolume"),
    detachVolume: unexpected("detachVolume"),
    deleteVolume: unexpected("deleteVolume"),
    waitForAction: unexpected("waitForAction"),
    listServerTypes: unexpected("listServerTypes"),
    listLocations: unexpected("listLocations"),
    listImages: unexpected("listImages"),
  };
}

/** The seam injection passed to every autoscaler under test. */
function deps(): NodeAutoscalerDeps {
  return {
    provider: fakeProvider(),
    isConfigured: () => providerConfigured,
  };
}

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

describe("NodeAutoscaler provisioning via the ComputeProvider seam", () => {
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
    mocks.buildUserData.mockClear();
    mocks.countAllocated.mockClear();
    mocks.countRetained.mockClear();
    mocks.nodes = [];
    mocks.findAllNodes.mockImplementation(() => Promise.resolve(mocks.nodes));
    mocks.countAllocated.mockResolvedValue(0);
    mocks.countRetained.mockResolvedValue(0);
    providerConfigured = true;
    mocks.buildUserData.mockReturnValue("#cloud-config\n");
    mocks.createServer.mockResolvedValue({
      server: {
        id: 4242,
        name: "node-test",
        status: "initializing",
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

  test("creates a server (via the injected provider) and registers the autoscaled docker node", async () => {
    const autoscaler = new NodeAutoscaler(policy, () => Date.parse("2026-05-15T12:00:00Z"), deps());

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
    const autoscaler = new NodeAutoscaler(policy, undefined, deps());

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

  test("fails before calling the provider when it is not configured", async () => {
    providerConfigured = false;
    const autoscaler = new NodeAutoscaler(policy, undefined, deps());

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
    const autoscaler = new NodeAutoscaler(policy, undefined, deps());
    mocks.createServer.mockResolvedValue({
      server: {
        id: 7777,
        name: "generated",
        status: "initializing",
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
    const autoscaler = new NodeAutoscaler(policy, undefined, deps());
    const seen = new Set<string>();
    const N = 50;

    for (let i = 0; i < N; i++) {
      mocks.createNode.mockClear();
      mocks.createServer.mockResolvedValue({
        server: {
          id: 8000 + i,
          name: "generated",
          status: "initializing",
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
    const autoscaler = new NodeAutoscaler(policy, undefined, deps());

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
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "../../../db/repositories/docker-nodes";

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
};

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

mock.module("../../config/containers-env", () => ({
  containersEnv: {
    defaultAgentImage: () => "ghcr.io/elizaos/eliza:latest",
    defaultAgentImagePlatform: () => "linux/arm64",
    defaultHcloudLocation: () => "fsn1",
    defaultHcloudServerType: () => "cax21",
  },
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
  beforeEach(() => {
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
        public_net: {
          ipv4: { ip: "203.0.113.10" },
          ipv6: null,
        },
      },
      rootPassword: "root-secret",
    });
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
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": "node-test",
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
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "@/db/schemas/docker-nodes";

const NOW = Date.parse("2026-05-05T12:00:00.000Z");

type WorkloadCounts = Record<string, { allocated: number; retained: number }>;

function makeNode(overrides: Partial<DockerNode> & Pick<DockerNode, "node_id">): DockerNode {
  const now = new Date(NOW - 60 * 60 * 1000);
  return {
    id: `id-${overrides.node_id}`,
    node_id: overrides.node_id,
    hostname: `${overrides.node_id}.example.com`,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: now,
    ssh_user: "root",
    host_key_fingerprint: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function policy() {
  return {
    minFreeSlotsBuffer: 4,
    minHotAvailableSlots: 1,
    maxNodes: 8,
    scaleUpCooldownMs: 5 * 60 * 1000,
    idleNodeMinAgeMs: 30 * 60 * 1000,
    defaultServerType: "cax21",
    defaultLocation: "fsn1",
    defaultImage: "ubuntu-24.04",
    defaultCapacity: 8,
  };
}

function installMocks(nodes: DockerNode[], counts: WorkloadCounts): void {
  mock.module("@/db/repositories/docker-nodes", () => ({
    dockerNodesRepository: {
      findAll: async () => nodes,
      findByNodeId: async (nodeId: string) => nodes.find((node) => node.node_id === nodeId) ?? null,
    },
  }));

  mock.module("@/lib/services/docker-node-workloads", () => ({
    countAllocatedWorkloadsOnNode: async (nodeId: string) => counts[nodeId]?.allocated ?? 0,
    countRetainedWorkloadsOnNode: async (nodeId: string) => counts[nodeId]?.retained ?? 0,
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }));
}

async function importAutoscaler() {
  const url = new URL(
    `../../lib/services/containers/node-autoscaler.ts?test=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  return import(url.href) as Promise<typeof import("@/lib/services/containers/node-autoscaler")>;
}

describe("NodeAutoscaler hot agent capacity", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("ignores unhealthy enabled nodes and bypasses cooldown below the hot floor", async () => {
    const nodes = [
      makeNode({
        node_id: "healthy-full",
        capacity: 1,
        status: "healthy",
        created_at: new Date(NOW - 60_000),
      }),
      makeNode({
        node_id: "offline-spare",
        capacity: 100,
        status: "offline",
      }),
    ];
    installMocks(nodes, {
      "healthy-full": { allocated: 1, retained: 1 },
      "offline-spare": { allocated: 0, retained: 0 },
    });

    const { NodeAutoscaler } = await importAutoscaler();
    const decision = await new NodeAutoscaler(policy(), () => NOW).evaluateCapacity();

    expect(decision.totalCapacity).toBe(1);
    expect(decision.totalAllocated).toBe(1);
    expect(decision.totalAvailable).toBe(0);
    expect(decision.enabledNodeCount).toBe(2);
    expect(decision.healthyNodeCount).toBe(1);
    expect(decision.shouldScaleUp).toBe(true);
    expect(decision.reason).toBe("available 0 < hot floor 1");
  });

  test("respects cooldown when buffer is low but one hot slot is still available", async () => {
    const nodes = [
      makeNode({
        node_id: "healthy-warm",
        capacity: 2,
        status: "healthy",
        created_at: new Date(NOW - 60_000),
      }),
    ];
    installMocks(nodes, {
      "healthy-warm": { allocated: 1, retained: 1 },
    });

    const { NodeAutoscaler } = await importAutoscaler();
    const decision = await new NodeAutoscaler(policy(), () => NOW).evaluateCapacity();

    expect(decision.totalAvailable).toBe(1);
    expect(decision.shouldScaleUp).toBe(false);
    expect(decision.reason).toBe("would scale up but cooldown active");
  });

  test("retained agent/container workloads block node drain", async () => {
    const nodes = [
      makeNode({ node_id: "empty-old", capacity: 4 }),
      makeNode({ node_id: "agent-old", capacity: 4 }),
    ];
    installMocks(nodes, {
      "empty-old": { allocated: 0, retained: 0 },
      "agent-old": { allocated: 0, retained: 1 },
    });

    const { NodeAutoscaler } = await importAutoscaler();
    const decision = await new NodeAutoscaler(policy(), () => NOW).evaluateCapacity();

    expect(decision.shouldScaleDownNodeIds).toEqual(["empty-old"]);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode, DockerNodeStatus } from "@/db/schemas/docker-nodes";

const NOW = new Date("2026-05-06T12:00:00.000Z");

function makeNode(overrides: Partial<DockerNode> & Pick<DockerNode, "node_id">): DockerNode {
  const { node_id, ...rest } = overrides;
  return {
    id: `id-${node_id}`,
    node_id,
    hostname: `${node_id}.example.com`,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: NOW,
    ssh_user: "root",
    host_key_fingerprint: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...rest,
  };
}

async function importManager() {
  const url = new URL(
    `../../lib/services/docker-node-manager.ts?test=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  return import(url.href) as Promise<typeof import("@/lib/services/docker-node-manager")>;
}

async function withImmediateRetryDelays<T>(fn: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    _timeout?: number,
    ...args: unknown[]
  ) => {
    callback(...args);
    return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

describe("DockerNodeManager", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("skips stale healthy autoscaled nodes that fail the live SSH/Docker probe and marks them offline", async () => {
    const nodes = [
      makeNode({
        node_id: "stale",
        capacity: 10,
        // Autoscaled (Hetzner Cloud) nodes flap to offline on ssh probe
        // failure so the autoscaler can drain + reprovision them.
        metadata: { provider: "hetzner-cloud", autoscaled: true },
      }),
      makeNode({ node_id: "ready", capacity: 4 }),
    ];
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => nodes,
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
          const node = nodes.find((candidate) => candidate.node_id === nodeId);
          if (node) node.status = status;
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: (hostname: string) => ({
          connect: async () => {
            if (hostname.startsWith("stale.")) {
              throw new Error("All configured authentication methods failed");
            }
          },
          exec: async () => "docker-id",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const selected = await DockerNodeManager.getInstance().getAvailableNode();

    expect(selected?.node_id).toBe("ready");
    expect(statusUpdates).toEqual([
      { nodeId: "stale", status: "offline" },
      { nodeId: "ready", status: "healthy" },
    ]);
  });

  test("does NOT mark canonical (non-autoscaled) nodes offline when ssh probe fails", async () => {
    // Canonical nodes (operator-provisioned, no `metadata.autoscaled === true`)
    // are protected from health-check flapping. Their status is left intact in
    // the DB; operators retain explicit `enabled=false` to remove them from
    // rotation. Rationale: these nodes host long-lived production sandboxes
    // and a transient ssh hiccup should not pull them out of the pool.
    const nodes = [
      makeNode({ node_id: "stale-canonical", capacity: 100, metadata: {} }),
      makeNode({ node_id: "ready", capacity: 4 }),
    ];
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => nodes,
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
          const node = nodes.find((candidate) => candidate.node_id === nodeId);
          if (node) node.status = status;
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: (hostname: string) => ({
          connect: async () => {
            if (hostname.startsWith("stale-canonical.")) {
              throw new Error("All configured authentication methods failed");
            }
          },
          exec: async () => "docker-id",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const selected = await DockerNodeManager.getInstance().getAvailableNode();

    // Selection still falls through to the healthy `ready` node (canonical
    // node failed ensureNodeReady's probe so it was skipped for THIS pick).
    expect(selected?.node_id).toBe("ready");
    // Critical: NO `offline` status write for the canonical node.
    expect(statusUpdates).toEqual([{ nodeId: "ready", status: "healthy" }]);
    // The canonical node's in-memory status is unchanged (still healthy).
    expect(nodes.find((n) => n.node_id === "stale-canonical")?.status).toBe("healthy");
  });

  test("healthCheckAll reports prior status for canonical nodes when suppressing failed probes", async () => {
    const nodes = [
      makeNode({ node_id: "canonical", status: "healthy", metadata: {} }),
      makeNode({
        node_id: "autoscaled",
        status: "healthy",
        metadata: { provider: "hetzner-cloud", autoscaled: true },
      }),
    ];
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => nodes,
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
          const node = nodes.find((candidate) => candidate.node_id === nodeId);
          if (node) node.status = status;
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: () => ({
          connect: async () => {
            throw new Error("All configured authentication methods failed");
          },
          exec: async () => "docker-id",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const results = await withImmediateRetryDelays(() =>
      DockerNodeManager.getInstance().healthCheckAll(),
    );

    expect(results.get("canonical")).toBe("healthy");
    expect(results.get("autoscaled")).toBe("offline");
    expect(statusUpdates).toEqual([{ nodeId: "autoscaled", status: "offline" }]);
    expect(nodes.find((node) => node.node_id === "canonical")?.status).toBe("healthy");
  });

  test("healthCheckNode returns prior status (not phantom 'offline') for canonical nodes that fail probe", async () => {
    // Regression: /api/v1/cron/agent-hot-pool exposes the return value of
    // healthCheckAll/healthCheckNode in its response body. If we suppress the
    // DB write for canonical nodes but still return "offline", consumers see
    // a status that contradicts the persisted row. Return node.status instead.
    const node = makeNode({
      node_id: "canonical",
      status: "healthy",
      metadata: {},
    });
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => [node],
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: () => ({
          connect: async () => {
            throw new Error("All configured authentication methods failed");
          },
          exec: async () => "docker-id",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const status = await DockerNodeManager.getInstance().healthCheckNode(node);

    // Returns the prior persisted status, not the phantom "offline".
    expect(status).toBe("healthy");
    // No DB write at all for the canonical node.
    expect(statusUpdates).toEqual([]);
  }, 15_000);

  test("healthCheckNode marks autoscaled nodes offline and returns 'offline'", async () => {
    const node = makeNode({
      node_id: "autoscaled",
      status: "healthy",
      metadata: { provider: "hetzner-cloud", autoscaled: true },
    });
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => [node],
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: () => ({
          connect: async () => {
            throw new Error("All configured authentication methods failed");
          },
          exec: async () => "docker-id",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const status = await DockerNodeManager.getInstance().healthCheckNode(node);

    expect(status).toBe("offline");
    expect(statusUpdates).toEqual([{ nodeId: "autoscaled", status: "offline" }]);
  }, 15_000);

  test("healthCheckNode does NOT mark canonical nodes degraded when Docker returns an empty ID", async () => {
    const node = makeNode({ node_id: "canonical-empty", status: "healthy", metadata: {} });
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => [node],
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
          node.status = status;
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: () => ({
          connect: async () => {},
          exec: async () => "",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const status = await DockerNodeManager.getInstance().healthCheckNode(node);

    expect(status).toBe("healthy");
    expect(statusUpdates).toEqual([]);
    expect(node.status).toBe("healthy");
  });

  test("probes unknown nodes so newly bootstrapped capacity can become available", async () => {
    const nodes = [makeNode({ node_id: "new-node", status: "unknown", capacity: 8 })];
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => nodes,
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
          const node = nodes.find((candidate) => candidate.node_id === nodeId);
          if (node) node.status = status;
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: () => ({
          connect: async () => {},
          exec: async () => "docker-id|x86_64",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const selected = await DockerNodeManager.getInstance().getAvailableNode({
      requiredPlatform: "linux/amd64",
    });

    expect(selected?.node_id).toBe("new-node");
    expect(statusUpdates).toEqual([{ nodeId: "new-node", status: "healthy" }]);
  });

  test("skips ARM nodes when an amd64 image platform is required", async () => {
    const nodes = [
      makeNode({
        node_id: "arm-node",
        capacity: 10,
        metadata: { provider: "hetzner-cloud", serverType: "cax21" },
      }),
      makeNode({
        node_id: "x86-node",
        capacity: 4,
        metadata: { provider: "hetzner-cloud", serverType: "cpx32" },
      }),
    ];
    const statusUpdates: Array<{ nodeId: string; status: DockerNodeStatus }> = [];
    const probedHosts: string[] = [];

    mock.module("@/db/repositories/docker-nodes", () => ({
      dockerNodesRepository: {
        findEnabled: async () => nodes,
        updateStatus: async (nodeId: string, status: DockerNodeStatus) => {
          statusUpdates.push({ nodeId, status });
        },
      },
    }));
    mock.module("@/lib/services/docker-node-workloads", () => ({
      countAllocatedWorkloadsOnNode: async () => 0,
      countRetainedWorkloadsOnNode: async () => 0,
    }));
    mock.module("@/lib/services/docker-ssh", () => ({
      DockerSSHClient: {
        getClient: (hostname: string) => ({
          connect: async () => {
            probedHosts.push(hostname);
          },
          exec: async () => "docker-id|x86_64",
        }),
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const { DockerNodeManager } = await importManager();
    const selected = await DockerNodeManager.getInstance().getAvailableNode({
      requiredPlatform: "linux/amd64",
    });

    expect(selected?.node_id).toBe("x86-node");
    expect(probedHosts).toEqual(["x86-node.example.com"]);
    expect(statusUpdates).toEqual([{ nodeId: "x86-node", status: "healthy" }]);
  });
});

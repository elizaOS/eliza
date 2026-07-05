/**
 * TOFU-persist wiring tests (manager side).
 *
 * The PR's core fix: when a `docker_nodes` row is unpinned
 * (`host_key_fingerprint = NULL`), `DockerNodeManager.sshClientForNode(node)`
 * wires an `onHostKeyDiscovered` callback into the SSH client. After the client
 * accepts the presented key on first connect and captures its fingerprint, that
 * callback persists the fingerprint via
 * `dockerNodesRepository.setHostKeyFingerprint(node_id, fingerprint)` — so every
 * later connect verifies against a real pin.
 *
 * These drive the REAL manager (`healthCheckNode`) with a stubbed repository and
 * a stubbed SSH client that models the boundary: `getClient` captures the wired
 * `onHostKeyDiscovered`, and `connect()` fires it with a concrete captured
 * fingerprint exactly as docker-ssh's post-`ready` handler does — but only when
 * a callback was actually wired (i.e. the row was NULL-pinned). We assert:
 *   1. an unpinned node persists the discovered fingerprint exactly once;
 *   2. a pinned node wires NO callback and NEVER persists.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";
import * as realNodeDiskNs from "./node-disk-manager";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };
const realNodeDisk = { ...realNodeDiskNs };

/** The concrete fingerprint the fake handshake "discovers" for an unpinned node. */
const DISCOVERED_FP = "abc123discoveredfingerprint";

const repoCalls = {
  updateStatus: [] as Array<{ nodeId: string; status: string }>,
  setHostKeyFingerprint: [] as Array<{ nodeId: string; fingerprint: string }>,
};

/**
 * Records the `onHostKeyDiscovered` callback each `getClient` call was wired
 * with (undefined when the row was already pinned), so tests can assert the
 * manager only wires it for NULL-pinned nodes.
 */
const wiredCallbacks: Array<
  ((hostname: string, fingerprint: string) => Promise<void>) | undefined
> = [];

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    updateStatus: (nodeId: string, status: string) => {
      repoCalls.updateStatus.push({ nodeId, status });
      return Promise.resolve();
    },
    setHostKeyFingerprint: (nodeId: string, fingerprint: string) => {
      repoCalls.setHostKeyFingerprint.push({ nodeId, fingerprint });
      return Promise.resolve();
    },
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: () => Promise.resolve(0),
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    // Mirror the real getClient signature: the 5th arg is onHostKeyDiscovered,
    // which the manager passes ONLY when the node row is unpinned.
    getClient: (
      _hostname: string,
      _port?: number,
      _hostKeyFingerprint?: string,
      _username?: string,
      onHostKeyDiscovered?: (hostname: string, fingerprint: string) => Promise<void>,
    ) => {
      wiredCallbacks.push(onHostKeyDiscovered);
      return {
        // On connect, fire the wired callback with a captured fingerprint —
        // exactly as docker-ssh's post-`ready` handler does after accepting an
        // unpinned host key via TOFU. A pinned row wires no callback, so this
        // no-ops for it.
        connect: async () => {
          if (onHostKeyDiscovered) {
            await onHostKeyDiscovered(_hostname, DISCOVERED_FP);
          }
        },
        exec: () => Promise.resolve("DOCKER-ID-123"),
      };
    },
  },
}));

mock.module("./node-disk-manager", () => ({
  ...realNodeDisk,
  probeNodeDiskUsage: () => Promise.resolve(null),
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
  mock.module("./node-disk-manager", () => realNodeDisk);
});

import { __resetNodeHealthFailureStateForTests, DockerNodeManager } from "./docker-node-manager";

function node(nodeId: string, hostKeyFingerprint: string | null): DockerNode {
  return {
    id: `${nodeId}-uuid`,
    node_id: nodeId,
    hostname: `${nodeId}.example.test`,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: hostKeyFingerprint,
    metadata: {},
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  __resetNodeHealthFailureStateForTests();
  repoCalls.updateStatus = [];
  repoCalls.setHostKeyFingerprint = [];
  wiredCallbacks.length = 0;
});

describe("DockerNodeManager TOFU-persist wiring", () => {
  test("unpinned node persists the discovered fingerprint exactly once", async () => {
    // Arrange: a node row with a NULL host_key_fingerprint (the class every
    // freshly-onboarded staging node ships as).
    const manager = DockerNodeManager.getInstance();
    const target = node("unpinned-node", null);

    // Act: run the real health check, which builds the SSH client via
    // sshClientForNode and connects.
    const status = await manager.healthCheckNode(target);

    // Assert: the manager wired the persist callback, and connect fired it,
    // persisting the captured fingerprint through the repo exactly once.
    expect(status).toBe("healthy");
    expect(wiredCallbacks).toHaveLength(1);
    expect(wiredCallbacks[0]).toBeDefined();
    expect(repoCalls.setHostKeyFingerprint).toEqual([
      { nodeId: "unpinned-node", fingerprint: DISCOVERED_FP },
    ]);
  });

  test("pinned node wires no callback and never persists a fingerprint", async () => {
    // Arrange: a node that already carries a pin — strict verification, no TOFU.
    const manager = DockerNodeManager.getInstance();
    const target = node("pinned-node", "SHA256:existing-pin");

    // Act.
    const status = await manager.healthCheckNode(target);

    // Assert: no callback wired (5th getClient arg was undefined), and the repo
    // pin-write is never called — a real key change must surface as a MISMATCH,
    // never a silent re-pin.
    expect(status).toBe("healthy");
    expect(wiredCallbacks).toEqual([undefined]);
    expect(repoCalls.setHostKeyFingerprint).toHaveLength(0);
  });
});

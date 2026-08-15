/**
 * Cordon semantics for node placement.
 *
 * The point of `placement_state` is that it is NOT `enabled=false`. Disabling a
 * node also drops it out of the health sweep, allocated-count sync, disk
 * monitoring and the orphan reconciler — the loops that must keep watching a
 * box precisely while its residents are being moved off it. These tests drive
 * the REAL manager with a stubbed repository and SSH client, and pin both
 * halves of that contract: a cordoned node is invisible to selection and still
 * visible to the operational sweeps.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };

let allNodes: DockerNode[] = [];
const readsUsed: string[] = [];
const probedHosts: string[] = [];

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    // The stub mirrors the real predicates so the test exercises the manager's
    // CHOICE of read, which is the whole behaviour under test.
    findEnabled: () => {
      readsUsed.push("findEnabled");
      return Promise.resolve(allNodes.filter((n) => n.enabled));
    },
    findPlaceable: () => {
      readsUsed.push("findPlaceable");
      return Promise.resolve(allNodes.filter((n) => n.enabled && n.placement_state === "open"));
    },
    updateStatus: () => Promise.resolve(),
    setHostKeyFingerprint: () => Promise.resolve(),
    markOfflineAndDisable: () => Promise.resolve(),
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: () => Promise.resolve(0),
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: (hostname: string) => ({
      connect: () => Promise.resolve(),
      exec: () => {
        probedHosts.push(hostname);
        return Promise.resolve("GH4Y:2NWO:testdockerid|x86_64");
      },
    }),
  },
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
});

import { DockerNodeManager } from "./docker-node-manager";

function node(nodeId: string, hostname: string, overrides: Partial<DockerNode> = {}): DockerNode {
  return {
    id: `${nodeId}-uuid`,
    node_id: nodeId,
    hostname,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    placement_state: "open",
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: "SHA256:test",
    metadata: {},
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  allNodes = [];
  readsUsed.length = 0;
  probedHosts.length = 0;
});

describe("placement selection", () => {
  test("never places onto a cordoned node", async () => {
    allNodes = [
      node("robot-6", "195.201.57.227", { placement_state: "cordoned" }),
      node("robot-2", "178.63.251.122"),
    ];

    const selected = await new DockerNodeManager().getAvailableNode();

    expect(selected?.node_id).toBe("robot-2");
    expect(readsUsed).toContain("findPlaceable");
    expect(readsUsed).not.toContain("findEnabled");
  });

  test("refuses every non-open state, not just cordoned", async () => {
    for (const state of ["cordoned", "evacuating", "drained"] as const) {
      allNodes = [node("robot-6", "195.201.57.227", { placement_state: state })];
      expect(await new DockerNodeManager().getAvailableNode()).toBeNull();
    }
  });

  test("an open node is still selected, so the cordon is not a blanket refusal", async () => {
    allNodes = [node("robot-2", "178.63.251.122")];
    const selected = await new DockerNodeManager().getAvailableNode();
    expect(selected?.node_id).toBe("robot-2");
  });
});

describe("operational sweeps keep watching a cordoned node", () => {
  test("health checks still probe it — this is what enabled=false would have broken", async () => {
    allNodes = [
      node("robot-6", "195.201.57.227", { placement_state: "evacuating" }),
      node("robot-2", "178.63.251.122"),
    ];

    const verdicts = await new DockerNodeManager().healthCheckAll();

    // Both boxes probed, and the evacuating one has a verdict: its residents
    // are still serving and are about to move, so it is the worst possible
    // moment to stop looking at it.
    expect(probedHosts).toContain("195.201.57.227");
    expect(verdicts.has("robot-6")).toBe(true);
    expect(readsUsed).toContain("findEnabled");
  });

  test("the operational read returns cordoned nodes and the placement read does not", async () => {
    allNodes = [
      node("robot-6", "195.201.57.227", { placement_state: "cordoned" }),
      node("robot-2", "178.63.251.122"),
    ];

    const { dockerNodesRepository } = await import("../../db/repositories/docker-nodes");
    const operational = await dockerNodesRepository.findEnabled();
    const placeable = await dockerNodesRepository.findPlaceable();

    expect(operational.map((n) => n.node_id).sort()).toEqual(["robot-2", "robot-6"]);
    expect(placeable.map((n) => n.node_id)).toEqual(["robot-2"]);
  });

  test("a disabled node leaves both sets, so enabled still means what it meant", async () => {
    allNodes = [node("robot-6", "195.201.57.227", { enabled: false })];

    const { dockerNodesRepository } = await import("../../db/repositories/docker-nodes");
    expect(await dockerNodesRepository.findEnabled()).toHaveLength(0);
    expect(await dockerNodesRepository.findPlaceable()).toHaveLength(0);
  });
});

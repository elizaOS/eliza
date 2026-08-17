/**
 * Robot-first placement tests (#18485).
 *
 * The drift these pin, measured on prod 2026-08-12: dedicated agents overflow
 * onto autoscaled Hetzner Cloud CCX33s at ~€35/agent-slot/mo while
 * hand-registered robot boxes carry the identical workload at ~€3-4.5/slot,
 * because getAvailableNode sorted on free slots alone and a freshly bought
 * cloud node always looks emptiest. These tests drive the REAL manager with a
 * stubbed SSH client + repository (same harness as the memory-admission
 * tests), plus pure-function coverage of the fleet classifier and comparator.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realLoggerNs from "../utils/logger";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };
const realLogger = { ...realLoggerNs };

let enabledNodes: DockerNode[] = [];
let allocatedByNodeId: Record<string, number> = {};

mock.module("../utils/logger", () => ({
  ...realLogger,
  logger: { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} },
}));

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: () => Promise.resolve(enabledNodes),
    findPlaceable: () => Promise.resolve(enabledNodes),
    updateStatus: () => Promise.resolve(),
    rotateNodeHostKeyFingerprint: () => Promise.resolve(),
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: (nodeId: string) =>
    Promise.resolve(allocatedByNodeId[nodeId] ?? 0),
}));

/** Alive, not IO-starved: readiness passes so only ordering is under test. */
const HEALTHY_PROBE = [
  "GH4Y:2NWO:testdockerid|x86_64",
  "---IO-PRESSURE---",
  "some avg10=1.02 avg60=0.98 avg300=1.11 total=499893023295",
  "full avg10=0.87 avg60=0.79 avg300=0.81 total=457451749125",
].join("\n");

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => ({
      connect: () => Promise.resolve(),
      exec: () => Promise.resolve(HEALTHY_PROBE),
    }),
  },
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
  mock.module("../utils/logger", () => realLogger);
});

import {
  comparePlacementCandidates,
  DockerNodeManager,
  isRobotFleetNode,
} from "./docker-node-manager";

function node(nodeId: string, metadata: Record<string, unknown>, capacity = 4): DockerNode {
  return {
    id: `${nodeId}-uuid`,
    node_id: nodeId,
    hostname: `${nodeId}.example`,
    ssh_port: 22,
    capacity,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: "SHA256:test",
    metadata,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const AUTOSCALED_META = {
  provider: "hetzner-cloud",
  autoscaled: true,
  location: "fsn1",
};

beforeEach(() => {
  enabledNodes = [];
  allocatedByNodeId = {};
});

describe("isRobotFleetNode", () => {
  test("explicit metadata.fleet wins in both directions", () => {
    expect(isRobotFleetNode(node("r", { fleet: "robot", location: "fsn1" }))).toBe(true);
    expect(isRobotFleetNode(node("c", { fleet: "cloud" }))).toBe(false);
  });

  test("autoscaled cloud nodes are never robot", () => {
    expect(isRobotFleetNode(node("c", AUTOSCALED_META))).toBe(false);
  });

  test("a location string marks cloud even without the autoscaled flag", () => {
    expect(isRobotFleetNode(node("c", { location: "nbg1" }))).toBe(false);
  });

  test("hand-registered nodes with neither marker are robot", () => {
    expect(isRobotFleetNode(node("r", {}))).toBe(true);
  });
});

describe("comparePlacementCandidates", () => {
  const robot = (id: string, available: number) => ({ node: node(id, {}), available });
  const cloud = (id: string, available: number) => ({
    node: node(id, AUTOSCALED_META),
    available,
  });

  test("a robot with fewer free slots outranks a cloud node with more", () => {
    const sorted = [cloud("cloud-1", 7), robot("robot-1", 1)].sort(comparePlacementCandidates);
    expect(sorted.map((c) => c.node.node_id)).toEqual(["robot-1", "cloud-1"]);
  });

  test("within a fleet the least-loaded (most free slots) node still wins", () => {
    const sorted = [
      robot("robot-tight", 1),
      cloud("cloud-tight", 2),
      robot("robot-roomy", 5),
      cloud("cloud-roomy", 6),
    ].sort(comparePlacementCandidates);
    expect(sorted.map((c) => c.node.node_id)).toEqual([
      "robot-roomy",
      "robot-tight",
      "cloud-roomy",
      "cloud-tight",
    ]);
  });

  test("equal fleet and equal availability compare as equal (stable order)", () => {
    expect(comparePlacementCandidates(robot("a", 3), robot("b", 3))).toBe(0);
  });
});

describe("getAvailableNode robot-first selection", () => {
  test("prefers a nearly-full robot over an empty autoscaled cloud node", async () => {
    const robot = node("eliza-prod-robot-2", { fleet: "robot" }, 11);
    const cloud = node("eliza-core-autoscaled", AUTOSCALED_META, 8);
    enabledNodes = [cloud, robot];
    allocatedByNodeId = { "eliza-prod-robot-2": 10, "eliza-core-autoscaled": 0 };

    const selected = await DockerNodeManager.getInstance().getAvailableNode();

    expect(selected?.node_id).toBe("eliza-prod-robot-2");
  });

  test("falls back to cloud only when every robot is full", async () => {
    const robot = node("eliza-prod-robot-3", {}, 4);
    const cloud = node("eliza-core-autoscaled", AUTOSCALED_META, 8);
    enabledNodes = [robot, cloud];
    allocatedByNodeId = { "eliza-prod-robot-3": 4, "eliza-core-autoscaled": 2 };

    const selected = await DockerNodeManager.getInstance().getAvailableNode();

    expect(selected?.node_id).toBe("eliza-core-autoscaled");
  });

  test("keeps excludeNodeId semantics across fleets", async () => {
    const robotA = node("robot-a", {}, 4);
    const robotB = node("robot-b", {}, 4);
    enabledNodes = [robotA, robotB];
    allocatedByNodeId = { "robot-a": 0, "robot-b": 3 };

    const selected = await DockerNodeManager.getInstance().getAvailableNode({
      excludeNodeId: "robot-a",
    });

    expect(selected?.node_id).toBe("robot-b");
  });
});

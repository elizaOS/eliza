/**
 * Placement circuit-breaker and IO-pressure readiness tests (#17880).
 *
 * The outage these pin: a node that is alive but IO-starved passes the
 * `docker info` liveness probe, gets selected for every provision (it is the
 * only node with free slots precisely when the fleet is saturated), and then
 * times out every `docker create`. These tests drive the REAL manager with a
 * stubbed SSH client + repository and assert that (1) measured docker-command
 * timeouts quarantine a node out of selection, and (2) a node reporting
 * pathological /proc/pressure/io is refused at readiness time.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };

const repoCalls = {
  updateStatus: [] as Array<{ nodeId: string; status: string }>,
};

let enabledNodes: DockerNode[] = [];

const sshMock = {
  connect: mock(),
  exec: mock(),
};

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: () => Promise.resolve(enabledNodes),
    updateStatus: (nodeId: string, status: string) => {
      repoCalls.updateStatus.push({ nodeId, status });
      return Promise.resolve();
    },
    setHostKeyFingerprint: () => Promise.resolve(),
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: () => Promise.resolve(0),
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => sshMock,
  },
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
});

import {
  __resetPlacementTimeoutStateForTests,
  clearPlacementCommandFailures,
  DockerNodeManager,
  isNodePlacementQuarantined,
  notePlacementCommandFailure,
  parseIoPressureFullAvg10,
} from "./docker-node-manager";

function node(nodeId: string): DockerNode {
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
    host_key_fingerprint: "SHA256:test",
    metadata: {},
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const TIMEOUT_ERROR = new Error(
  "[docker-sandbox] Failed to create container on node-a: [docker-ssh] Command timed out after 60000ms on 88.99.66.168: docker [redacted]",
);

/** Verbatim /proc/pressure/io captured on the #17880 outage node. */
const OUTAGE_PSI = [
  "some avg10=75.21 avg60=82.04 avg300=82.69 total=493046940717",
  "full avg10=72.89 avg60=78.50 avg300=78.61 total=450805502651",
].join("\n");

const HEALTHY_PSI = [
  "some avg10=0.00 avg60=0.31 avg300=0.12 total=1093046940",
  "full avg10=0.00 avg60=0.24 avg300=0.09 total=450805502",
].join("\n");

function probeOutput(psi: string | null): string {
  const sections = ["docker-id-1|x86_64", "---IO-PRESSURE---"];
  if (psi !== null) sections.push(psi);
  return sections.join("\n");
}

const T0 = 1_700_000_000_000;
const MINUTE = 60 * 1000;

beforeEach(() => {
  __resetPlacementTimeoutStateForTests();
  repoCalls.updateStatus = [];
  enabledNodes = [];
  sshMock.connect.mockReset();
  sshMock.exec.mockReset();
});

describe("parseIoPressureFullAvg10", () => {
  test("reads full avg10 from real /proc/pressure/io content", () => {
    expect(parseIoPressureFullAvg10(OUTAGE_PSI)).toBe(72.89);
    expect(parseIoPressureFullAvg10(HEALTHY_PSI)).toBe(0);
  });

  test("returns null when the signal is absent or malformed — never a fake zero", () => {
    expect(parseIoPressureFullAvg10("")).toBeNull();
    expect(
      parseIoPressureFullAvg10("cat: /proc/pressure/io: No such file"),
    ).toBeNull();
    // A "some" line alone must not satisfy the "full" gate.
    expect(
      parseIoPressureFullAvg10(
        "some avg10=75.21 avg60=82.04 avg300=82.69 total=1",
      ),
    ).toBeNull();
  });
});

describe("placement circuit breaker", () => {
  test("quarantines a node at the third docker timeout inside the window", () => {
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0);
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0 + MINUTE);
    expect(isNodePlacementQuarantined("node-a", T0 + MINUTE)).toBe(false);

    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0 + 2 * MINUTE);
    expect(isNodePlacementQuarantined("node-a", T0 + 2 * MINUTE)).toBe(true);
  });

  test("non-timeout failures never open the breaker", () => {
    const otherError = new Error(
      "pull access denied for ghcr.io/elizaos/eliza",
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      notePlacementCommandFailure("node-a", otherError, T0 + attempt * MINUTE);
    }
    expect(isNodePlacementQuarantined("node-a", T0 + 5 * MINUTE)).toBe(false);
  });

  test("timeouts older than the window do not count toward the threshold", () => {
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0);
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0 + MINUTE);
    // Third timeout lands after the first two fell out of the 10-minute window.
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0 + 15 * MINUTE);
    expect(isNodePlacementQuarantined("node-a", T0 + 15 * MINUTE)).toBe(false);
  });

  test("quarantine expires after its cooldown", () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0);
    }
    expect(isNodePlacementQuarantined("node-a", T0 + 14 * MINUTE)).toBe(true);
    expect(isNodePlacementQuarantined("node-a", T0 + 15 * MINUTE + 1)).toBe(
      false,
    );
  });

  test("a successful container operation clears the accumulated history", () => {
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0);
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0);
    clearPlacementCommandFailures("node-a");
    notePlacementCommandFailure("node-a", TIMEOUT_ERROR, T0 + MINUTE);
    expect(isNodePlacementQuarantined("node-a", T0 + MINUTE)).toBe(false);
  });
});

describe("getAvailableNode under quarantine", () => {
  test("skips a quarantined node and selects the next candidate", async () => {
    const manager = DockerNodeManager.getInstance();
    enabledNodes = [node("node-quarantined"), node("node-ok")];
    for (let attempt = 0; attempt < 3; attempt++) {
      notePlacementCommandFailure("node-quarantined", TIMEOUT_ERROR);
    }
    sshMock.exec.mockResolvedValue(probeOutput(HEALTHY_PSI));

    const selected = await manager.getAvailableNode();

    expect(selected?.node_id).toBe("node-ok");
  });

  test("returns null when every capacity-bearing node is quarantined, without probing them", async () => {
    const manager = DockerNodeManager.getInstance();
    enabledNodes = [node("node-quarantined")];
    for (let attempt = 0; attempt < 3; attempt++) {
      notePlacementCommandFailure("node-quarantined", TIMEOUT_ERROR);
    }

    const selected = await manager.getAvailableNode();

    expect(selected).toBeNull();
    // Quarantine is decided before the SSH probe — a drowning node must not
    // receive even probe traffic from selection.
    expect(sshMock.exec).not.toHaveBeenCalled();
  });
});

describe("ensureNodeReady IO-pressure gate", () => {
  test("refuses an IO-starved node and does not mark it healthy", async () => {
    const manager = DockerNodeManager.getInstance();
    sshMock.exec.mockResolvedValue(probeOutput(OUTAGE_PSI));

    const ready = await manager.ensureNodeReady(node("node-starved"));

    expect(ready).toBe(false);
    expect(repoCalls.updateStatus).toEqual([]);
  });

  test("accepts a node with healthy IO pressure", async () => {
    const manager = DockerNodeManager.getInstance();
    sshMock.exec.mockResolvedValue(probeOutput(HEALTHY_PSI));

    const ready = await manager.ensureNodeReady(node("node-ok"));

    expect(ready).toBe(true);
    expect(repoCalls.updateStatus).toEqual([
      { nodeId: "node-ok", status: "healthy" },
    ]);
  });

  test("a missing PSI signal never blocks placement", async () => {
    const manager = DockerNodeManager.getInstance();
    sshMock.exec.mockResolvedValue(probeOutput(null));

    const ready = await manager.ensureNodeReady(node("node-old-kernel"));

    expect(ready).toBe(true);
    expect(repoCalls.updateStatus).toEqual([
      { nodeId: "node-old-kernel", status: "healthy" },
    ]);
  });
});

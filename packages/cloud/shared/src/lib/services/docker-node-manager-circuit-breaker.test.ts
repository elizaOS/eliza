/**
 * Placement-circuit tests exercise timeout quarantine and Linux PSI readiness
 * with a deterministic SSH/repository harness; no real node is contacted.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };

const updateStatus = mock(async () => {});
const sshMock = {
  connect: mock(async () => {}),
  exec: mock(async () => ""),
};

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    updateStatus,
    setHostKeyFingerprint: mock(async () => {}),
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
  __getNodePlacementCircuitStateForTests,
  __resetNodePlacementCircuitStateForTests,
  DockerNodeManager,
  parseIoPressureFullAvg60,
} from "./docker-node-manager";

const savedThreshold = process.env.CONTAINERS_NODE_DOCKER_TIMEOUT_FAILURE_THRESHOLD;
const savedCooldown = process.env.CONTAINERS_NODE_CIRCUIT_BREAKER_COOLDOWN_MS;
const savedIoThreshold = process.env.CONTAINERS_NODE_IO_PRESSURE_FULL_AVG60_THRESHOLD;

function node(): DockerNode {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    node_id: "node-psi-test",
    hostname: "192.0.2.80",
    ssh_port: 22,
    capacity: 8,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: "SHA256:test",
    metadata: {},
    created_at: new Date("2026-08-07T00:00:00.000Z"),
    updated_at: new Date("2026-08-07T00:00:00.000Z"),
  };
}

beforeEach(() => {
  __resetNodePlacementCircuitStateForTests();
  process.env.CONTAINERS_NODE_DOCKER_TIMEOUT_FAILURE_THRESHOLD = "2";
  process.env.CONTAINERS_NODE_CIRCUIT_BREAKER_COOLDOWN_MS = "300000";
  process.env.CONTAINERS_NODE_IO_PRESSURE_FULL_AVG60_THRESHOLD = "50";
  updateStatus.mockClear();
  sshMock.connect.mockClear();
  sshMock.exec.mockReset();
});

afterEach(() => {
  __resetNodePlacementCircuitStateForTests();
});

afterAll(() => {
  if (savedThreshold === undefined) {
    delete process.env.CONTAINERS_NODE_DOCKER_TIMEOUT_FAILURE_THRESHOLD;
  } else {
    process.env.CONTAINERS_NODE_DOCKER_TIMEOUT_FAILURE_THRESHOLD = savedThreshold;
  }
  if (savedCooldown === undefined) {
    delete process.env.CONTAINERS_NODE_CIRCUIT_BREAKER_COOLDOWN_MS;
  } else {
    process.env.CONTAINERS_NODE_CIRCUIT_BREAKER_COOLDOWN_MS = savedCooldown;
  }
  if (savedIoThreshold === undefined) {
    delete process.env.CONTAINERS_NODE_IO_PRESSURE_FULL_AVG60_THRESHOLD;
  } else {
    process.env.CONTAINERS_NODE_IO_PRESSURE_FULL_AVG60_THRESHOLD = savedIoThreshold;
  }
});

describe("Docker node placement circuit", () => {
  test("opens after repeated Docker command timeouts and skips readiness work", async () => {
    const manager = DockerNodeManager.getInstance();
    const timeout = new Error(
      "[docker-ssh] Command timed out after 60000ms on 192.0.2.80: docker [redacted]",
    );

    expect(manager.recordNodeDockerCommandFailure(node().node_id, timeout)).toBe(true);
    expect(__getNodePlacementCircuitStateForTests(node().node_id)?.openUntilMs).toBe(0);
    expect(manager.recordNodeDockerCommandFailure(node().node_id, timeout)).toBe(true);
    expect(__getNodePlacementCircuitStateForTests(node().node_id)?.openUntilMs).toBeGreaterThan(
      Date.now(),
    );

    await expect(manager.ensureNodeReady(node())).resolves.toBe(false);
    expect(sshMock.connect).not.toHaveBeenCalled();
    expect(sshMock.exec).not.toHaveBeenCalled();
  });

  test("a successful provision closes the circuit", async () => {
    const manager = DockerNodeManager.getInstance();
    const timeout = new Error("Command timed out after 60000ms");
    manager.recordNodeDockerCommandFailure(node().node_id, timeout);
    manager.recordNodeDockerCommandFailure(node().node_id, timeout);
    manager.recordNodeProvisionSuccess(node().node_id);

    sshMock.exec.mockImplementation(async (command: string) => {
      if (command.startsWith("docker info")) return "docker-id|x86_64";
      if (command === "cat /proc/pressure/io") {
        return "some avg10=0.00 avg60=0.10 avg300=0.20 total=1\nfull avg10=0.00 avg60=0.20 avg300=0.30 total=1\n";
      }
      return "";
    });

    await expect(manager.ensureNodeReady(node())).resolves.toBe(true);
    expect(updateStatus).toHaveBeenCalledWith(node().node_id, "healthy");
  });

  test("high full-IO pressure opens a cooldown even while Docker responds", async () => {
    const manager = DockerNodeManager.getInstance();
    sshMock.exec.mockImplementation(async (command: string) => {
      if (command.startsWith("docker info")) return "docker-id|amd64";
      if (command === "cat /proc/pressure/io") {
        return "some avg10=80.00 avg60=90.00 avg300=50.00 total=1\nfull avg10=70.00 avg60=78.50 avg300=40.00 total=1\n";
      }
      return "";
    });

    await expect(manager.ensureNodeReady(node())).resolves.toBe(false);
    expect(__getNodePlacementCircuitStateForTests(node().node_id)?.reason).toContain(
      "I/O pressure full avg60=78.50%",
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test("an unavailable PSI file preserves Docker-only readiness", async () => {
    const manager = DockerNodeManager.getInstance();
    sshMock.exec.mockImplementation(async (command: string) => {
      if (command.startsWith("docker info")) return "docker-id|amd64";
      throw new Error("cat: /proc/pressure/io: No such file");
    });

    await expect(manager.ensureNodeReady(node())).resolves.toBe(true);
  });

  test("a timed-out PSI probe rejects readiness and contributes to quarantine", async () => {
    const manager = DockerNodeManager.getInstance();
    sshMock.exec.mockImplementation(async (command: string) => {
      if (command.startsWith("docker info")) return "docker-id|amd64";
      throw new Error("[docker-ssh] Command timed out after 5000ms on 192.0.2.80: cat [redacted]");
    });

    await expect(manager.ensureNodeReady(node())).resolves.toBe(false);
    expect(__getNodePlacementCircuitStateForTests(node().node_id)?.consecutiveDockerTimeouts).toBe(
      1,
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("parseIoPressureFullAvg60", () => {
  test("extracts the full avg60 value without confusing the some line", () => {
    expect(
      parseIoPressureFullAvg60(
        "some avg10=1.00 avg60=2.00 avg300=3.00 total=4\nfull avg10=5.00 avg60=78.50 avg300=7.00 total=8\n",
      ),
    ).toBe(78.5);
  });

  test("fails closed to unavailable for malformed or unsupported output", () => {
    expect(parseIoPressureFullAvg60("some avg60=99.00\n")).toBeNull();
    expect(parseIoPressureFullAvg60("full avg10=1.00 total=2\n")).toBeNull();
  });
});

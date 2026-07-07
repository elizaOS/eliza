/**
 * Pre-pull self-heal tests cover the SSH commands that run on Docker nodes
 * after a timed-out image pre-pull. The harness uses a fake SSH client so the
 * production safety rules are asserted without killing local processes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetPrePullFailureStateForTests,
  buildPrePullReapCommand,
  buildPrePullSelfHealRecoverCommand,
  buildTrackedPrePullCommand,
  DockerNodeManager,
  isPrePullTimeoutError,
} from "./docker-node-manager";

const IMAGE = "ghcr.io/elizaos/eliza:test-prepull";
const PID_FILE = "/tmp/eliza-prepull-test.pid";

type RecoveryHarness = {
  recoverAfterTimedOutPrePull: (
    ssh: { exec: (command: string, timeoutMs?: number) => Promise<string> },
    node: { node_id: string; hostname: string },
    pidFile: string,
    image: string,
  ) => Promise<void>;
};

function managerHarness(): RecoveryHarness {
  return DockerNodeManager.getInstance() as unknown as RecoveryHarness;
}

function fakeSsh() {
  const commands: string[] = [];
  return {
    commands,
    ssh: {
      exec: mock(async (command: string) => {
        commands.push(command);
        return "";
      }),
    },
  };
}

const originalSelfHealEnv = process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART;
const originalLegacySelfHealEnv = process.env.ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART;

beforeEach(() => {
  __resetPrePullFailureStateForTests();
  delete process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART;
  delete process.env.ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART;
});

afterEach(() => {
  __resetPrePullFailureStateForTests();
  if (originalSelfHealEnv === undefined) {
    delete process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART;
  } else {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = originalSelfHealEnv;
  }
  if (originalLegacySelfHealEnv === undefined) {
    delete process.env.ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART;
  } else {
    process.env.ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART = originalLegacySelfHealEnv;
  }
});

describe("pre-pull timeout classification", () => {
  test("recovers only DockerSSHClient timeout failures", () => {
    expect(
      isPrePullTimeoutError(
        new Error("[docker-ssh] Command timed out after 300000ms on node: sh [redacted]"),
      ),
    ).toBe(true);
    expect(
      isPrePullTimeoutError(
        new Error("[docker-ssh] Command exited with code 1 on node: manifest unknown"),
      ),
    ).toBe(false);
    expect(isPrePullTimeoutError(new Error("pull access denied"))).toBe(false);
  });
});

describe("tracked pre-pull commands", () => {
  test("wraps docker pull with a per-attempt PID file", () => {
    const tracked = buildTrackedPrePullCommand(IMAGE, "linux/amd64", "test-marker");

    expect(tracked.pidFile).toBe("/tmp/eliza-prepull-test-marker.pid");
    expect(tracked.command).toContain("docker pull");
    expect(tracked.command).toContain("--platform");
    expect(tracked.command).toContain("linux/amd64");
    expect(tracked.command).toContain(IMAGE);
    expect(tracked.command).toContain("printf");
  });

  test("tracked pre-pull script is dash-parseable: no '&;' from joining after the backgrounded pull", () => {
    const tracked = buildTrackedPrePullCommand(IMAGE, "linux/amd64", "test-marker");

    // Regression: joining the script lines with "; " turned `(docker pull …) &`
    // into `&;`, a hard dash syntax error ("Syntax error: \";\" unexpected") —
    // every pull/provision on a node failed at parse time.
    expect(tracked.command).not.toContain("&;");
    expect(tracked.command).not.toContain("& ;");
  });

  test("builds a scoped reap command for only the recorded pre-pull PID", () => {
    const command = buildPrePullReapCommand(PID_FILE, IMAGE);

    expect(command).toContain(PID_FILE);
    expect(command).toContain("/proc/$pid/cmdline");
    expect(command).toContain('grep -F "docker pull"');
    expect(command).toContain(IMAGE);
    expect(command).toContain('kill -9 "$pid"');
    expect(command).not.toContain("pkill");
    // Regression: "; "-joining `if …; then` yields `then;` (dash syntax error).
    expect(command).not.toContain("then;");
  });

  test("builds a force recovery command for a daemon whose graceful restart hangs", () => {
    const command = buildPrePullSelfHealRecoverCommand();

    expect(command).toContain("systemctl kill -s SIGKILL docker.service docker.socket");
    expect(command).toContain("systemctl restart containerd");
    expect(command).toContain("systemctl reset-failed docker.service");
    expect(command).toContain("systemctl start docker.service");
    expect(command).not.toContain("systemctl restart docker");
  });
});

describe("pre-pull self-heal restart policy", () => {
  test("reaps the scoped PID but does not restart docker when self-heal is disabled", async () => {
    const { ssh, commands } = fakeSsh();

    await managerHarness().recoverAfterTimedOutPrePull(
      ssh,
      { node_id: "node-a", hostname: "node-a.example.test" },
      PID_FILE,
      IMAGE,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(PID_FILE);
    expect(commands[0]).not.toContain("pkill");
    expect(
      commands.some((command) => command.includes("systemctl kill -s SIGKILL docker.service")),
    ).toBe(false);
  });

  test("force-recovers docker only after repeated timeout symptoms and then honors cooldown", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const { ssh, commands } = fakeSsh();
    const node = { node_id: "node-b", hostname: "node-b.example.test" };

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) => command.includes("systemctl kill -s SIGKILL docker.service")),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.includes("systemctl restart containerd")),
    ).toHaveLength(1);
    expect(commands.join("\n")).not.toContain("systemctl restart docker");

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) => command.includes("systemctl kill -s SIGKILL docker.service")),
    ).toHaveLength(1);
  });

  test("records cooldown even when force recovery fails", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("systemctl kill -s SIGKILL docker.service")) {
          throw new Error("force recovery failed");
        }
        return "";
      }),
    };
    const node = { node_id: "node-c", hostname: "node-c.example.test" };

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) => command.includes("systemctl kill -s SIGKILL docker.service")),
    ).toHaveLength(1);

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) => command.includes("systemctl kill -s SIGKILL docker.service")),
    ).toHaveLength(1);
  });
});

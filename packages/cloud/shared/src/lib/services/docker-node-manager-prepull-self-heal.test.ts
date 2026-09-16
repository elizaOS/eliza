/**
 * Pre-pull self-heal tests cover the SSH commands that run on Docker nodes
 * after a timed-out image pre-pull. A fake SSH client checks production policy;
 * real shell children execute generated commands against isolated tool fixtures.
 * The harness waits for child closure and rejects deadline expiration.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetPrePullFailureStateForTests,
  buildPrePullReapCommand,
  buildPrePullSelfHealRecoverCommand,
  buildTrackedPrePullCommand,
  DockerNodeManager,
  isDockerSshCommandTimeoutError,
} from "./docker-node-manager";

class ShellDeadlineError extends Error {
  constructor(readonly pid: number | undefined) {
    super("Recovery shell exceeded its deadline");
  }
}

function runRecoveryShell(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: "ignore", detached: true });
    let timedOut = false;
    let spawnError: Error | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          // error-policy:J6 an already-exited process group needs no further teardown.
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
            spawnError = new Error("Unable to stop recovery shell process group", { cause: error });
            child.kill("SIGKILL");
          }
        }
      }
    }, timeoutMs);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new ShellDeadlineError(child.pid));
      else if (code === null) reject(new Error(`Recovery shell terminated by ${signal}`));
      else resolve(code);
    });
  });
}

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
      isDockerSshCommandTimeoutError(
        new Error("[docker-ssh] Command timed out after 300000ms on node: sh [redacted]"),
      ),
    ).toBe(true);
    expect(
      isDockerSshCommandTimeoutError(
        new Error("pre-pull wrapper", {
          cause: new Error("[docker-ssh] Command timed out after 300000ms on node: sh [redacted]"),
        }),
      ),
    ).toBe(true);
    expect(
      isDockerSshCommandTimeoutError(
        new Error("[docker-ssh] Command exited with code 1 on node: manifest unknown"),
      ),
    ).toBe(false);
    expect(isDockerSshCommandTimeoutError(new Error("pull access denied"))).toBe(false);
  });
});

describe("tracked pre-pull commands", () => {
  test("reaps the shell before rejecting a command deadline", async () => {
    let failure: Error | undefined;
    try {
      await runRecoveryShell("exec /bin/sleep 30", process.env, 100);
    } catch (error) {
      // error-policy:J1 inspect the real timed-out child after the harness closes it.
      if (!(error instanceof Error)) throw error;
      failure = error;
    }
    expect(failure).toBeInstanceOf(ShellDeadlineError);
    if (!(failure instanceof ShellDeadlineError) || failure.pid === undefined) {
      throw new Error("Expected a spawned shell to hit its deadline");
    }
    const pid = failure.pid;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
    expect(() => process.kill(-pid, 0)).toThrow(/ESRCH|No such process/);
  });

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

    expect(command).toStartWith("set -e; ");
    expect(command).toContain("docker info --format '{{.LiveRestoreEnabled}}'");
    expect(command).toContain("systemctl kill --kill-who=main -s SIGKILL docker.service");
    expect(command).toContain(
      "systemctl kill --kill-who=main -s SIGKILL docker.service 2>/dev/null || true",
    );
    expect(command).toContain("systemctl stop docker.socket 2>/dev/null || true");
    expect(command).not.toContain("systemctl restart containerd");
    expect(command).toContain("systemctl reset-failed docker.service");
    expect(command).toContain("systemctl start docker.service");
    expect(command).toContain("timeout -k 2s 20s docker info");
    expect(command).not.toContain("systemctl restart docker");
  });

  test.each([
    { runtimeValue: "true", status: 0, recovers: true },
    { runtimeValue: "false", status: 0, recovers: false },
    { runtimeValue: "", status: 0, recovers: false },
    { runtimeValue: "true", status: 124, recovers: false },
  ])("executes recovery only with successful active-daemon proof: %j", async (probe) => {
    const directory = mkdtempSync(join(tmpdir(), "docker-live-restore-proof-"));
    const journal = join(directory, "mutations");
    writeFileSync(journal, "");
    try {
      const executables = {
        timeout: '#!/bin/sh\nshift 3\nexec "$@"\n',
        docker:
          '#!/bin/sh\nif [ "$2" = --format ]; then printf "%s\\n" "$PROBE_VALUE"; exit "$PROBE_STATUS"; fi\n',
        systemctl: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MUTATION_JOURNAL"\n',
        sleep: "#!/bin/sh\nexit 0\n",
      };
      for (const [name, source] of Object.entries(executables)) {
        writeFileSync(join(directory, name), source, { mode: 0o700 });
      }
      const status = await runRecoveryShell(buildPrePullSelfHealRecoverCommand(), {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        PROBE_VALUE: probe.runtimeValue,
        PROBE_STATUS: String(probe.status),
        MUTATION_JOURNAL: journal,
      });
      if (probe.recovers) {
        expect(status).toBe(0);
        expect(readFileSync(journal, "utf8")).toContain("start docker.service");
      } else {
        expect(status).not.toBe(0);
        expect(readFileSync(journal, "utf8")).toBe("");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      commands.filter((command) =>
        command.includes("systemctl kill --kill-who=main -s SIGKILL docker.service"),
      ),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.includes("systemctl stop docker.socket")),
    ).toHaveLength(1);
    expect(commands.join("\n")).not.toContain("systemctl restart containerd");

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) =>
        command.includes("systemctl kill --kill-who=main -s SIGKILL docker.service"),
      ),
    ).toHaveLength(1);
  });

  test("records cooldown even when force recovery fails", async () => {
    process.env.CONTAINERS_PREPULL_SELF_HEAL_RESTART = "true";
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("systemctl kill --kill-who=main -s SIGKILL docker.service")) {
          throw new Error("force recovery failed");
        }
        return "";
      }),
    };
    const node = { node_id: "node-c", hostname: "node-c.example.test" };

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) =>
        command.includes("systemctl kill --kill-who=main -s SIGKILL docker.service"),
      ),
    ).toHaveLength(1);

    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);
    await managerHarness().recoverAfterTimedOutPrePull(ssh, node, PID_FILE, IMAGE);

    expect(
      commands.filter((command) =>
        command.includes("systemctl kill --kill-who=main -s SIGKILL docker.service"),
      ),
    ).toHaveLength(1);
  });
});

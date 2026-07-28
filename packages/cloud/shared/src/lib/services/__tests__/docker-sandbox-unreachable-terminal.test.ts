/**
 * Behavioral test for the agent_delete WEDGE fix: an UNREACHABLE node during a
 * container stop must be TERMINAL, not retryable.
 *
 * Before the fix, when both `docker stop` and `docker rm -f` failed because the
 * node was unreachable (SSH connect/exec timeout), `DockerSandboxProvider.stop()`
 * threw "Failed to stop container ...". That throw propagated up through
 * `deleteAgent` -> `executeDeletion` -> `executeAgentDelete`, which re-queued the
 * job (attempts < 3) and re-ran the ~20-65s stop path every cycle, eventually
 * pushing the worker's work cycle past the 300s watchdog so the liveness
 * heartbeat was withheld and the agents API failed closed.
 *
 * The fix: classify both-legs-unreachable as "container gone" and let `stop()`
 * RESOLVE (after a warn). With stop() resolving, `deleteAgent`'s try succeeds,
 * the row DELETE runs, and the job completes terminally — no re-queue.
 *
 * This test drives the real `DockerSandboxProvider.stop()` with remote SSH,
 * capacity accounting, and host-port persistence isolated at their boundaries.
 * The in-memory container seed keeps locator resolution deterministic.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";

// Fake SSH client: getClient() returns an object whose exec() rejects with a
// caller-controlled error. Registered BEFORE importing the provider so the
// provider binds to this mock.
let nextExecError: Error = new Error("unset");
mock.module("../docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => ({
      exec: async () => {
        throw nextExecError;
      },
    }),
  },
}));

import { DockerSandboxProvider } from "../docker-sandbox-provider";

const SANDBOX_ID = "agent-unreachable-test";
const releaseHostPorts = mock(async () => 0);
const decrementAllocated = mock(async (_nodeId: string) => undefined);
const originalDecrementAllocated = dockerNodesRepository.decrementAllocated;

type ContainerMetaSeed = {
  nodeId: string;
  hostname: string;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  sshPort: number;
  sshUser: string;
};

function seedContainer(provider: DockerSandboxProvider): void {
  // resolveContainer() has a fast path that returns straight from the private
  // in-memory `containers` map, so seeding it avoids any DB hydration.
  const meta: ContainerMetaSeed = {
    nodeId: "node-1",
    hostname: "138.201.80.125",
    containerName: SANDBOX_ID,
    bridgePort: 3001,
    webUiPort: 3002,
    agentId: SANDBOX_ID,
    sshPort: 22,
    sshUser: "root",
  };
  (provider as unknown as { containers: Map<string, ContainerMetaSeed> }).containers.set(
    SANDBOX_ID,
    meta,
  );
}

describe("DockerSandboxProvider.stop() terminal policy on unreachable node", () => {
  beforeEach(() => {
    // Headscale deletion is skipped when not configured.
    delete process.env.HEADSCALE_API_KEY;
    releaseHostPorts.mockClear();
    decrementAllocated.mockClear();
    dockerNodesRepository.decrementAllocated = decrementAllocated;
  });

  afterEach(() => {
    dockerNodesRepository.decrementAllocated = originalDecrementAllocated;
  });

  test("RESOLVES (no throw) when both stop and rm fail with an SSH timeout", async () => {
    nextExecError = new Error(
      "[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms",
    );
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    // The fix means this no longer throws: an unreachable node is terminal, so
    // the caller (deleteAgent) proceeds to the row DELETE and the job completes
    // instead of re-queuing and re-running the ~20-65s stop path each cycle.
    await expect(provider.stop(SANDBOX_ID)).resolves.toBeUndefined();
    expect(releaseHostPorts).not.toHaveBeenCalled();
    expect(decrementAllocated).toHaveBeenCalledWith("node-1");
  });

  test("replacement stop REJECTS when the node is unreachable", async () => {
    nextExecError = new Error(
      "[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms",
    );
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    await expect(provider.stopForReplacement(SANDBOX_ID)).rejects.toThrow(
      /Failed to stop container/,
    );
  });

  test("replacement stop REJECTS generic not-found failures without container absence proof", async () => {
    nextExecError = new Error("ssh helper binary not found");
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    await expect(provider.stopForReplacement(SANDBOX_ID)).rejects.toThrow(
      /Failed to stop container/,
    );
  });

  test("replacement stop accepts an explicit Docker no-such-container response", async () => {
    nextExecError = new Error("Error response from daemon: No such container: agent-x");
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    await expect(provider.stopForReplacement(SANDBOX_ID)).resolves.toBeUndefined();
    expect(releaseHostPorts).toHaveBeenCalledTimes(1);
    expect(releaseHostPorts).toHaveBeenCalledWith({
      nodeId: "node-1",
      ownerKind: "agent",
      ownerId: SANDBOX_ID,
    });
    expect(decrementAllocated).toHaveBeenCalledWith("node-1");
  });

  test("still THROWS when both legs fail for a non-unreachable, non-gone reason", async () => {
    // A genuine daemon error on a REACHABLE node must NOT be abandoned — the
    // container may still be running, so the delete should escalate/retry.
    nextExecError = new Error(
      "Error response from daemon: cannot stop container: permission denied",
    );
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    await expect(provider.stop(SANDBOX_ID)).rejects.toThrow(/Failed to stop container/);
  });

  test("still THROWS on a per-command timeout (reachable-but-slow node, NOT terminal)", async () => {
    // A docker-ssh PER-COMMAND timeout means the SSH channel opened (node
    // reachable) but the docker command was slow (daemon hung/overloaded,
    // container ignoring SIGTERM, disk-I/O stall). The container may still be
    // running, so this must ESCALATE/retry — it must NOT be terminally deleted.
    nextExecError = new Error(
      "[docker-ssh] Command timed out after 25000ms on host: docker [redacted]",
    );
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    await expect(provider.stop(SANDBOX_ID)).rejects.toThrow(/Failed to stop container/);
  });

  test("RESOLVES when the container is already gone (existing behavior preserved)", async () => {
    nextExecError = new Error("Error response from daemon: No such container: agent-x");
    const provider = new DockerSandboxProvider({ releaseHostPorts });
    seedContainer(provider);

    await expect(provider.stop(SANDBOX_ID)).resolves.toBeUndefined();
    expect(releaseHostPorts).toHaveBeenCalledTimes(1);
    expect(releaseHostPorts).toHaveBeenCalledWith({
      nodeId: "node-1",
      ownerKind: "agent",
      ownerId: SANDBOX_ID,
    });
    expect(decrementAllocated).toHaveBeenCalledWith("node-1");
  });
});

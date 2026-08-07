/**
 * `DockerSandboxProvider` stop is remote-teardown-only (#17185).
 *
 * The provider used to decrement `docker_nodes.allocated_count` at the end of
 * every stop. That made local capacity arithmetic a side effect of a RETRYABLE
 * remote operation which treats "already gone" as success — so each retry after
 * a post-stop failure freed another slot, and the slot it freed belonged to a
 * live sibling on that node. Ownership of the counter moved to the caller's
 * deletion generation; the provider must now never touch it, on ANY outcome.
 *
 * Drives the real `DockerSandboxProvider` with only the SSH transport scripted
 * (the seam the issue names) and the container meta pre-seeded in memory, so the
 * real classification logic — already-absent, unreachable-abandon, genuine
 * failure — decides each path. `decrementAllocated` is spied, never stubbed out
 * of existence: the assertion is that the real method is never reached.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Scripted SSH transport. Registered BEFORE the provider import so the provider
// binds to it. `exec` is caller-controlled per test, which is what lets one
// harness cover success, already-absent, unreachable, and hard-failure paths.
let execBehavior: (command: string) => Promise<string> = async () => "";
mock.module("../docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => ({
      exec: async (command: string) => execBehavior(command),
    }),
  },
}));

import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import { DockerSandboxProvider } from "../docker-sandbox-provider";

const SANDBOX_ID = "agent-capacity-ownership-test";
const NODE_ID = "node-1";

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
  // resolveContainer() returns straight from the private in-memory map, so
  // seeding it keeps the DB out of the stop path entirely.
  (provider as unknown as { containers: Map<string, ContainerMetaSeed> }).containers.set(
    SANDBOX_ID,
    {
      nodeId: NODE_ID,
      hostname: "138.201.80.125",
      containerName: SANDBOX_ID,
      bridgePort: 3001,
      webUiPort: 3002,
      agentId: SANDBOX_ID,
      sshPort: 22,
      sshUser: "root",
    },
  );
}

let decrementSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Headscale deletion is skipped when unconfigured.
  delete process.env.HEADSCALE_API_KEY;
  decrementSpy = spyOn(dockerNodesRepository, "decrementAllocated");
});

afterEach(() => {
  decrementSpy.mockRestore();
});

describe("provider stop never mutates node capacity", () => {
  test("a clean stop + rm leaves allocated_count to the caller", async () => {
    execBehavior = async () => "";
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("an already-absent container does not release a slot a second time", async () => {
    // The retry shape from the issue: the first attempt tore the container down,
    // a downstream step failed, and the re-run finds it gone. Accepting that as
    // success is correct; decrementing again is what freed a live sibling's slot.
    execBehavior = async () => {
      throw new Error("Error response from daemon: No such container: agent-x");
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-proven",
    });
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("an unreachable container retains its capacity for reconciliation", async () => {
    execBehavior = async () => {
      throw new Error("[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms");
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).resolves.toEqual({
      kind: "not-running-unresolved",
      reason: "node-unreachable",
    });
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("a reachable stop failure rejects, so the caller never reaches its release", async () => {
    // This is how ownership survives a genuine failure: the provider throws, the
    // delete path returns before the release CAS, and the retry that finally
    // completes the teardown is the one that hands the slot back.
    execBehavior = async () => {
      throw new Error("Cannot connect to the Docker daemon");
    };
    const provider = new DockerSandboxProvider();
    seedContainer(provider);

    await expect(provider.stopForDeletion(SANDBOX_ID)).rejects.toThrow(/Failed to stop container/);
    expect(decrementSpy).not.toHaveBeenCalled();
  });

  test("replacement teardown DOES still release, because nothing else owns its slot", async () => {
    // The counter-free rule is scoped to deletion, not to the provider. Suspend,
    // shutdown, sleep, warm-claim retire and ghost cleanup all reach the same
    // stop path through `stopForReplacement`, stop exactly once under a fence,
    // and have no durable generation to hand the release to — so the provider
    // stays their capacity owner. `holdsCountedNodeSlot` treating a suspended
    // row as already-released depends on this decrement still happening.
    execBehavior = async () => "";
    const provider = new DockerSandboxProvider();
    seedContainer(provider);
    decrementSpy.mockResolvedValue(undefined);

    await expect(provider.stopForReplacement(SANDBOX_ID)).resolves.toBeUndefined();
    expect(decrementSpy).toHaveBeenCalledTimes(1);
    expect(decrementSpy).toHaveBeenCalledWith(NODE_ID);
  });
});

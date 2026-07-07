/**
 * Regression coverage for the docker health poll that follows an agent's
 * current node while provisioning jobs overlap. The harness stubs the poll wait
 * to fire synchronously and fakes SSH/DB reads so the multi-iteration path runs
 * without live docker nodes or a database.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";

type PollInternals = {
  pollSshDockerHealth: (meta: ContainerMetaShape, deadline: number) => Promise<boolean>;
  hydrateContainerFromDb: (sandboxId: string) => Promise<ContainerMetaShape | null>;
};

type ContainerMetaShape = {
  nodeId: string;
  hostname: string;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  sshPort: number;
  sshUser: string;
  hostKeyFingerprint?: string;
};

const OLD_NODE: ContainerMetaShape = {
  nodeId: "eliza-core-7b35da12",
  hostname: "91.98.38.74",
  containerName: "agent-506ed636-health",
  bridgePort: 18001,
  webUiPort: 28001,
  agentId: "506ed636-f3bc-4330-9eab-64913b28c61a",
  sshPort: 22,
  sshUser: "root",
};

const NEW_NODE: ContainerMetaShape = {
  ...OLD_NODE,
  nodeId: "eliza-core-e1a9c8ac",
  hostname: "167.233.102.171",
};

/**
 * One fake SSH client per host. The container only exists on `healthyHostname`,
 * so any other host's docker inspect / host-probe rejects exactly like the live
 * "no such object" loop.
 */
function fakeSshByHost(healthyHostname: string) {
  const probedHosts: string[] = [];
  const getClient = spyOn(DockerSSHClient, "getClient").mockImplementation(((hostname: string) => {
    probedHosts.push(hostname);
    return {
      exec: mock(async (command: string) => {
        if (hostname !== healthyHostname) {
          throw new Error(
            `[docker-ssh] Command exited with code 1 on ${hostname}: [stderr] error: no such object: agent-506ed636-`,
          );
        }
        // The healthy node passes both probe styles so either success path is valid.
        if (command.includes("docker inspect")) return "healthy";
        return "";
      }),
    } as unknown as DockerSSHClient;
  }) as unknown as typeof DockerSSHClient.getClient);
  return { getClient, probedHosts };
}

/** Fire every scheduled poll-wait synchronously so the loop runs instantly. */
function stubPollWaits() {
  return spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
}

afterEach(() => {
  mock.restore();
});

describe("pollSshDockerHealth follows agent re-placement (#15203)", () => {
  test("a node_id change mid-wait moves the probe to the new node instead of looping on the stale one", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;

    const { getClient, probedHosts } = fakeSshByHost(NEW_NODE.hostname);
    stubPollWaits();

    // Placement can change between probe iterations while the poll still holds
    // the metadata captured by the job that started it.
    const hydrate = spyOn(internals, "hydrateContainerFromDb")
      .mockResolvedValueOnce(OLD_NODE)
      .mockResolvedValue(NEW_NODE);

    const deadline = Date.now() + 60_000;
    const healthy = await internals.pollSshDockerHealth(OLD_NODE, deadline);

    expect(healthy).toBe(true);
    expect(hydrate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(probedHosts).toContain(OLD_NODE.hostname);
    expect(probedHosts).toContain(NEW_NODE.hostname);
    expect(probedHosts.at(-1)).toBe(NEW_NODE.hostname);
    getClient.mockRestore();
  });

  test("no re-placement: the poll stays on the node it was seeded with", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;

    const { getClient, probedHosts } = fakeSshByHost(OLD_NODE.hostname);
    stubPollWaits();
    spyOn(internals, "hydrateContainerFromDb").mockResolvedValue(OLD_NODE);

    const healthy = await internals.pollSshDockerHealth(OLD_NODE, Date.now() + 60_000);

    expect(healthy).toBe(true);
    expect(new Set(probedHosts)).toEqual(new Set([OLD_NODE.hostname]));
    getClient.mockRestore();
  });

  test("a transient DB failure during the poll keeps the last-known node rather than aborting", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;

    const { getClient, probedHosts } = fakeSshByHost(OLD_NODE.hostname);
    stubPollWaits();
    spyOn(internals, "hydrateContainerFromDb")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(OLD_NODE);

    const healthy = await internals.pollSshDockerHealth(OLD_NODE, Date.now() + 60_000);

    expect(healthy).toBe(true);
    expect(probedHosts).toContain(OLD_NODE.hostname);
    getClient.mockRestore();
  });
});

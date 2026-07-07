// Regression for #15203: the node-side docker health poll must follow the
// agent's CURRENT node. A placement-affecting job (upgrade + resume +
// provision-retry can overlap for one agent during a post-image-fix recovery
// storm) re-places the agent onto a different node mid-wait. The job that is
// polling health captured its node at job start; before the fix it kept SSHing
// the ORIGINAL node — which no longer holds the container — logging
// "error: no such object" in a tight loop until the 360s timeout killed an
// otherwise-healthy provision. The fix re-reads the node from the DB before
// every probe, so the poll follows the re-placement and passes on the new node.
//
// The poll's inter-iteration setTimeout is stubbed to fire synchronously so the
// multi-iteration path runs without wall-clock waits; the SSH client and the DB
// re-read are faked so no real node or database is touched.
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
  const getClient = spyOn(DockerSSHClient, "getClient").mockImplementation(
    ((hostname: string) => {
      probedHosts.push(hostname);
      return {
        exec: mock(async (command: string) => {
          if (hostname !== healthyHostname) {
            throw new Error(
              `[docker-ssh] Command exited with code 1 on ${hostname}: [stderr] error: no such object: agent-506ed636-`,
            );
          }
          // Host HTTP probe passes (exit 0); docker inspect reports healthy.
          if (command.includes("docker inspect")) return "healthy";
          return "";
        }),
      } as unknown as DockerSSHClient;
    }) as unknown as typeof DockerSSHClient.getClient,
  );
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

    // The container lives on NEW_NODE; the poll was seeded with OLD_NODE.
    const { getClient, probedHosts } = fakeSshByHost(NEW_NODE.hostname);
    stubPollWaits();

    // First re-read still sees the old placement (the re-placement commit lands
    // after this iteration); the second sees the new node.
    const hydrate = spyOn(internals, "hydrateContainerFromDb")
      .mockResolvedValueOnce(OLD_NODE)
      .mockResolvedValue(NEW_NODE);

    const deadline = Date.now() + 60_000;
    const healthy = await internals.pollSshDockerHealth(OLD_NODE, deadline);

    expect(healthy).toBe(true);
    // It re-read the node from the DB at least twice — once per poll iteration.
    expect(hydrate.mock.calls.length).toBeGreaterThanOrEqual(2);
    // It probed the stale node first (and failed), then followed the DB to the
    // new node and passed there.
    expect(probedHosts).toContain(OLD_NODE.hostname);
    expect(probedHosts).toContain(NEW_NODE.hostname);
    // The last host it dialed is the new node — the loop did not end on the
    // stale handle.
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

  test("a transient DB miss during the poll keeps the last-known node rather than aborting", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;

    const { getClient, probedHosts } = fakeSshByHost(OLD_NODE.hostname);
    stubPollWaits();
    // First re-read blips (DB unreachable → null); refreshNodeMeta must fall
    // back to the last-known node so the blip does not abort the poll.
    spyOn(internals, "hydrateContainerFromDb")
      .mockResolvedValueOnce(null)
      .mockResolvedValue(OLD_NODE);

    const healthy = await internals.pollSshDockerHealth(OLD_NODE, Date.now() + 60_000);

    expect(healthy).toBe(true);
    expect(probedHosts).toContain(OLD_NODE.hostname);
    getClient.mockRestore();
  });
});

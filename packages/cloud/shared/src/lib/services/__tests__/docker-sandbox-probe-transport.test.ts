/**
 * Coverage for the readiness-probe TRANSPORT-vs-NOT-READY classification and
 * the transport-retry window in pollSshDockerHealth (#15310 failure mode #6).
 *
 * The live incident: a HEALTHY dedicated container was marked failed and its row
 * wedged in `provisioning` because the readiness probe returned false on a
 * transient SSH/exec blip that never actually reached the container. These tests
 * pin that:
 *   - a probe window that ONLY ever hits SSH-transport failures resolves to the
 *     retryable `transport_unresolved` verdict (NOT the terminal `not_ready`),
 *   - a transport blip that CLEARS within the retry window resolves to `ready`
 *     without condemning the container,
 *   - a probe that REACHES the container but it stays unhealthy resolves to the
 *     terminal `not_ready` (the dead-provision self-heal is preserved).
 *
 * The poll wait is stubbed to fire synchronously so the multi-iteration + retry
 * window runs instantly.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";

type PollInternals = {
  pollSshDockerHealth: (
    meta: ContainerMetaShape,
    deadline: number,
  ) => Promise<{ ready: boolean; verdict: string }>;
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

const META: ContainerMetaShape = {
  nodeId: "eliza-core-abc",
  hostname: "10.0.0.9",
  containerName: "agent-probe-test",
  bridgePort: 18001,
  webUiPort: 28001,
  agentId: "agent-probe-test",
  sshPort: 22,
  sshUser: "root",
};

/**
 * Fire every scheduled poll-wait synchronously, AND advance a fake clock by the
 * requested delay so the deadline-driven while-loops actually terminate (the
 * transport-retry window is bounded by `Date.now() < retryDeadline`, so a
 * synchronous setTimeout that never advanced the clock would spin forever).
 */
function stubPollWaitsWithClock() {
  let now = 1_000_000;
  const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    delay?: number,
  ) => {
    now += typeof delay === "number" && delay > 0 ? delay : 1;
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  return { nowSpy, timeoutSpy };
}

/**
 * Install a fake SSH client whose `exec` is driven by a per-call script. Each
 * script entry decides what a single exec does: throw a transport error, throw
 * a remote non-zero exit, or return a value (used for the docker-inspect that
 * reports `healthy`).
 */
function fakeSsh(handler: (command: string) => string) {
  return spyOn(DockerSSHClient, "getClient").mockImplementation(
    (() =>
      ({
        exec: mock(async (command: string) => handler(command)),
      }) as unknown as DockerSSHClient) as unknown as typeof DockerSSHClient.getClient,
  );
}

const TRANSPORT_ERR = () => {
  throw new Error("[docker-ssh] Connection error for 10.0.0.9: ETIMEDOUT");
};
const REMOTE_NOT_READY = () => {
  // The host-probe shell ran and exited 1 (curl couldn't get a 2xx yet).
  throw new Error("[docker-ssh] Command exited with code 1 on 10.0.0.9: ");
};

afterEach(() => {
  mock.restore();
});

describe("pollSshDockerHealth transport-vs-not-ready classification (#15310 #6)", () => {
  test("ALL transport failures for the whole budget → transport_unresolved (retryable, NOT not_ready)", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;
    spyOn(internals, "hydrateContainerFromDb").mockResolvedValue(META);
    stubPollWaitsWithClock();
    // Every exec — host probe AND inspect — fails at the transport layer.
    fakeSsh(() => TRANSPORT_ERR());

    // A short budget: the main window is spent (the fake clock advances on each
    // wait), then the transport-retry window is spent the same way.
    const outcome = await internals.pollSshDockerHealth(META, Date.now() + 50);

    expect(outcome.ready).toBe(false);
    expect(outcome.verdict).toBe("transport_unresolved");
  });

  test("transport blip that CLEARS (container answers healthy) → ready, container never condemned", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;
    spyOn(internals, "hydrateContainerFromDb").mockResolvedValue(META);
    stubPollWaitsWithClock();

    // First host-probe fails transport; then the inspect answers healthy.
    let call = 0;
    fakeSsh((command: string) => {
      call += 1;
      if (call === 1) return TRANSPORT_ERR(); // host probe: transport
      if (command.includes("docker inspect")) return "healthy"; // inspect: reached + healthy
      return TRANSPORT_ERR();
    });

    const outcome = await internals.pollSshDockerHealth(META, Date.now() + 50);
    expect(outcome.ready).toBe(true);
    expect(outcome.verdict).toBe("ready");
  });

  test("REACHED but stays unhealthy for the budget → not_ready (dead-provision self-heal preserved)", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;
    spyOn(internals, "hydrateContainerFromDb").mockResolvedValue(META);
    stubPollWaitsWithClock();

    // Host probe exits non-zero (reached the container, curl not 2xx); inspect
    // returns a non-healthy status (reached, but not healthy). We reached the
    // container, so the verdict must be the TERMINAL not_ready, never transport.
    fakeSsh((command: string) => {
      if (command.includes("docker inspect")) return "starting";
      return REMOTE_NOT_READY();
    });

    const outcome = await internals.pollSshDockerHealth(META, Date.now() + 50);
    expect(outcome.ready).toBe(false);
    expect(outcome.verdict).toBe("not_ready");
  });

  test("host probe passes (2xx) → ready immediately", async () => {
    const provider = new DockerSandboxProvider();
    const internals = provider as unknown as PollInternals;
    spyOn(internals, "hydrateContainerFromDb").mockResolvedValue(META);
    stubPollWaitsWithClock();
    // Host probe exec resolves (exit 0) → ready on the first iteration.
    fakeSsh(() => "");

    const outcome = await internals.pollSshDockerHealth(META, Date.now() + 50);
    expect(outcome.ready).toBe(true);
    expect(outcome.verdict).toBe("ready");
  });
});

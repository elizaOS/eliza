// checkHealth ingress selection on the docker sandbox provider: tailnet-first
// with the node-side docker fallback that keeps a provision alive when the
// CP-side mesh socket is cold, and the still-dies guarantee that a container
// failing BOTH probes reports unhealthy — so a dead provision still times out
// and the provision path's reprovision self-heal is preserved. The probes
// themselves are spied (they are long-polling I/O loops); what this file pins
// is the wiring: which probes run for which ingress, in which order, and how
// the results combine.
import { describe, expect, spyOn, test } from "bun:test";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import type { SandboxHandle } from "../sandbox-provider-types";

type ProbeInternals = {
  resolveContainer: (sandboxId: string) => Promise<unknown>;
  pollTailnetHealth: (...args: unknown[]) => Promise<boolean>;
  pollSshDockerHealth: (...args: unknown[]) => Promise<{ ready: boolean; verdict: string }>;
};

const META = {
  nodeId: "node-1",
  hostname: "node-1.internal",
  containerName: "agent-test-1",
  bridgePort: 18923,
  webUiPort: 23816,
  agentId: "agent-test-1",
  sshPort: 22,
  sshUser: "root",
};

function makeHandle(headscaleIp?: string): SandboxHandle {
  return {
    sandboxId: "agent-test-1",
    bridgeUrl: "http://100.64.0.10:3000",
    healthUrl: "http://100.64.0.10:3000/api",
    metadata: {
      provider: "docker",
      ...META,
      volumePath: "/data/agents/agent-test-1",
      dockerImage: "ghcr.io/example/agent:latest",
      imageDigest: null,
      ...(headscaleIp ? { headscaleIp } : {}),
    },
  } as unknown as SandboxHandle;
}

function makeProvider(outcomes: { tailnet: boolean; sshDocker: boolean }) {
  const provider = new DockerSandboxProvider();
  const internals = provider as unknown as ProbeInternals;
  const resolveSpy = spyOn(internals, "resolveContainer").mockResolvedValue(META);
  const tailnetSpy = spyOn(internals, "pollTailnetHealth").mockResolvedValue(outcomes.tailnet);
  // pollSshDockerHealth now returns a SandboxHealthOutcome; map the boolean
  // fixture to a ready/not_ready verdict (transport_unresolved is covered in
  // the dedicated readiness-probe test).
  const sshSpy = spyOn(internals, "pollSshDockerHealth").mockResolvedValue(
    outcomes.sshDocker ? { ready: true, verdict: "ready" } : { ready: false, verdict: "not_ready" },
  );
  return { provider, resolveSpy, tailnetSpy, sshSpy };
}

describe("DockerSandboxProvider.checkHealth tailnet → node-side docker fallback", () => {
  test("tailnet pass is sufficient — the SSH fallback is never consulted", async () => {
    const { provider, tailnetSpy, sshSpy } = makeProvider({ tailnet: true, sshDocker: false });
    expect(await provider.checkHealth(makeHandle("100.64.0.10"))).toBe(true);
    expect(tailnetSpy).toHaveBeenCalledTimes(1);
    expect(sshSpy).not.toHaveBeenCalled();
  });

  test("tailnet miss + node-side docker healthy → healthy (cold CP mesh socket does not ghost-kill a healthy provision)", async () => {
    const { provider, tailnetSpy, sshSpy } = makeProvider({ tailnet: false, sshDocker: true });
    const before = Date.now();
    expect(await provider.checkHealth(makeHandle("100.64.0.10"))).toBe(true);
    expect(tailnetSpy).toHaveBeenCalledTimes(1);
    expect(sshSpy).toHaveBeenCalledTimes(1);
    // The fallback gets a FRESH deadline — the tailnet poll has already burned
    // the primary window, so reusing it would make the fallback a zero-iteration no-op.
    const [, fallbackDeadline] = sshSpy.mock.calls[0] as [unknown, number];
    expect(fallbackDeadline).toBeGreaterThan(before);
  });

  test("STILL DIES: tailnet miss + node-side docker miss → unhealthy, so a dead provision still times out", async () => {
    const { provider, tailnetSpy, sshSpy } = makeProvider({ tailnet: false, sshDocker: false });
    expect(await provider.checkHealth(makeHandle("100.64.0.10"))).toBe(false);
    expect(tailnetSpy).toHaveBeenCalledTimes(1);
    expect(sshSpy).toHaveBeenCalledTimes(1);
  });

  test("no headscale route → node-side docker health only, tailnet never dialed", async () => {
    const { provider, tailnetSpy, sshSpy } = makeProvider({ tailnet: true, sshDocker: true });
    expect(await provider.checkHealth(makeHandle())).toBe(true);
    expect(tailnetSpy).not.toHaveBeenCalled();
    expect(sshSpy).toHaveBeenCalledTimes(1);
  });
});

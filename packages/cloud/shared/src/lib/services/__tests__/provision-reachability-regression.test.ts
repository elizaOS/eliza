/**
 * Provision reachability regression — the "running but unreachable" canary.
 *
 * The prod incident this locks: a dedicated agent provisions and is marked
 * `running`, but its container never gets a Headscale IP registered/replicated
 * onto the record (`headscale_ip` stays null) and the node hostname can't be
 * resolved either. The DB row looks healthy (`status: "running"`), yet every
 * request to it is unroutable — there is no host to reach. This is distinct
 * from the cases already covered elsewhere:
 *   - provision -> `running` is locked by eliza-sandbox.test.ts (executeWake).
 *   - "prod provisioning without Headscale CONFIG is rejected at create()" is
 *     locked by docker-sandbox-headscale-route.test.ts.
 *   - delete terminal policy on an unreachable node is locked by
 *     docker-sandbox-unreachable-terminal.test.ts.
 * What was NOT locked: the host-resolution step that decides whether a
 * provisioned record is actually reachable. `getTrustedDockerBridgeBaseUrl` /
 * `getTrustedDockerWebBaseUrl` are that step — they MUST return null (→ caller
 * treats the agent as unreachable) when the record carries no usable route,
 * rather than fabricating a broken URL that reports a dead agent as live.
 *
 * Hermetic: only `dockerNodesRepository.findByNodeId` is stubbed (the node
 * hostname fallback); the resolvers touch nothing else.
 */
import { describe, expect, spyOn, test } from "bun:test";

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { DockerNode } from "../../../db/repositories/docker-nodes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import { ElizaSandboxService } from "../eliza-sandbox";

type BridgeRouteInput = Pick<AgentSandbox, "node_id" | "bridge_port" | "headscale_ip">;
type WebRouteInput = Pick<
  AgentSandbox,
  "node_id" | "web_ui_port" | "headscale_ip" | "health_url" | "bridge_url"
>;

// The resolvers are private; reach them through a typed view, mirroring the
// buildRuntimeBootstrapAgent test in eliza-sandbox.test.ts.
function resolvers() {
  return new ElizaSandboxService() as unknown as {
    getTrustedDockerBridgeBaseUrl(s: BridgeRouteInput): Promise<string | null>;
    getTrustedDockerWebBaseUrl(s: WebRouteInput): Promise<string | null>;
  };
}

function node(hostname: string): DockerNode {
  // The resolvers read only `.hostname`; the rest of DockerNode is irrelevant.
  return { hostname } as DockerNode;
}

describe("provision reachability — trusted Docker bridge route", () => {
  test("a Headscale IP yields a reachable bridge URL and never needs the node lookup", async () => {
    const findByNodeId = spyOn(dockerNodesRepository, "findByNodeId");
    try {
      const url = await resolvers().getTrustedDockerBridgeBaseUrl({
        node_id: "node-1",
        bridge_port: 18923,
        headscale_ip: "100.64.0.10",
      });
      expect(url).toBe("http://100.64.0.10:18923");
      // The mesh IP is authoritative — no DB round-trip for the hostname fallback.
      expect(findByNodeId).not.toHaveBeenCalled();
    } finally {
      findByNodeId.mockRestore();
    }
  });

  test("a missing Headscale IP falls back to the resolved node hostname", async () => {
    const findByNodeId = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(
      node("eliza-core-prod-2.elizacloud.ai"),
    );
    try {
      const url = await resolvers().getTrustedDockerBridgeBaseUrl({
        node_id: "node-1",
        bridge_port: 18923,
        headscale_ip: null,
      });
      expect(url).toBe("http://eliza-core-prod-2.elizacloud.ai:18923");
      expect(findByNodeId).toHaveBeenCalledWith("node-1");
    } finally {
      findByNodeId.mockRestore();
    }
  });

  test("CANARY: no Headscale IP and an unresolvable node => null (running-but-unreachable)", async () => {
    // The exact prod blocker: the IP never replicated AND the node row is gone /
    // hostname-less. A provisioned `running` record with `node_id` + `bridge_port`
    // but no usable host MUST resolve to null, so the caller reports the agent
    // unreachable instead of routing to a fabricated, dead URL.
    const findByNodeId = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(null);
    try {
      const url = await resolvers().getTrustedDockerBridgeBaseUrl({
        node_id: "node-1",
        bridge_port: 18923,
        headscale_ip: null,
      });
      expect(url).toBeNull();
    } finally {
      findByNodeId.mockRestore();
    }
  });

  test("no node signal at all => null (provision never landed a route)", async () => {
    const findByNodeId = spyOn(dockerNodesRepository, "findByNodeId");
    try {
      const url = await resolvers().getTrustedDockerBridgeBaseUrl({
        node_id: null,
        bridge_port: 18923,
        headscale_ip: null,
      });
      expect(url).toBeNull();
      // Short-circuits before any node lookup.
      expect(findByNodeId).not.toHaveBeenCalled();
    } finally {
      findByNodeId.mockRestore();
    }
  });
});

describe("provision reachability — trusted Docker web route", () => {
  test("a stored health_url wins as the trusted web origin", async () => {
    const findByNodeId = spyOn(dockerNodesRepository, "findByNodeId");
    try {
      const url = await resolvers().getTrustedDockerWebBaseUrl({
        node_id: "node-1",
        web_ui_port: 23816,
        headscale_ip: "100.64.0.10",
        health_url: "https://agent-runtime.example/health",
        bridge_url: null,
      });
      expect(url).toBe("https://agent-runtime.example");
      expect(findByNodeId).not.toHaveBeenCalled();
    } finally {
      findByNodeId.mockRestore();
    }
  });

  test("CANARY: no health_url, no Headscale IP, unresolvable node => null", async () => {
    const findByNodeId = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(null);
    try {
      const url = await resolvers().getTrustedDockerWebBaseUrl({
        node_id: "node-1",
        web_ui_port: 23816,
        headscale_ip: null,
        health_url: null,
        bridge_url: null,
      });
      expect(url).toBeNull();
    } finally {
      findByNodeId.mockRestore();
    }
  });
});

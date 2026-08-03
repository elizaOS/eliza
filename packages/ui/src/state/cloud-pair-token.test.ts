/** Verifies clearCloudPairApiToken through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Delete channel for the durable cloud-pair API token (#16666): the clear must
 * empty BOTH storages the write channel targets, or the boot adopter
 * re-adopts the dead credential on the next launch — and the agent-scoped
 * purge must destroy ONLY the proven agent's credentials, never unrelated
 * profiles. Per-agent keys (#17579) are cleared for the target agent only,
 * while the legacy global key is always cleared so a pre-#17579 bearer can
 * never be re-adopted by ANY agent after an explicit disconnect/sign-out.
 * jsdom + real storages; no network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCloudPairApiToken,
  clearStalePairCredentialsForAgent,
} from "./cloud-pair-token";
import { cloudPairTokenKeyForAgent } from "../components/auth/CloudPairRelay";

const LEGACY_KEY = "eliza:cloud-pair:api-token";
const ACTIVE_SERVER_KEY = "elizaos:active-server";
const PROFILES_KEY = "elizaos:agent-profiles";

function seedActiveServer(agentId: string): void {
  localStorage.setItem(
    ACTIVE_SERVER_KEY,
    JSON.stringify({
      id: `cloud:${agentId}`,
      kind: "cloud",
      label: "Dedicated agent",
      apiBase: `https://${agentId}.elizacloud.ai`,
      accessToken: `bearer-${agentId}`,
    }),
  );
}

function seedProfiles(): void {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify({
      version: 1,
      activeProfileId: "p1",
      profiles: [
        {
          id: "p1",
          label: "Agent A",
          kind: "cloud",
          apiBase: "https://agent-a.elizacloud.ai",
          accessToken: "token-a",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "p2",
          label: "Agent B",
          kind: "cloud",
          cloudAgentId: "agent-b",
          apiBase: "https://elizacloud.ai/api/v1/eliza/agents/agent-b",
          accessToken: "token-b",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "p3",
          label: "Self-hosted",
          kind: "remote",
          apiBase: "https://my-box.example.com",
          accessToken: "token-remote",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
}

function profileTokens(): Record<string, string | undefined> {
  const registry = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}") as {
    profiles: Array<{ id: string; accessToken?: string }>;
  };
  return Object.fromEntries(
    registry.profiles.map((p) => [p.id, p.accessToken]),
  );
}

describe("clearCloudPairApiToken", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("removes the target agent's per-agent key AND the legacy global key from BOTH storages", () => {
    const agentKey = cloudPairTokenKeyForAgent("agent-a");
    localStorage.setItem(agentKey, "stale-key");
    sessionStorage.setItem(agentKey, "stale-key");
    localStorage.setItem(LEGACY_KEY, "legacy-key");
    sessionStorage.setItem(LEGACY_KEY, "legacy-key");
    // Another agent's scoped key must survive an explicit sign-out for agent-a.
    const otherAgentKey = cloudPairTokenKeyForAgent("agent-b");
    localStorage.setItem(otherAgentKey, "keep-agent-b");
    localStorage.setItem("eliza:unrelated", "keep-me");

    clearCloudPairApiToken("agent-a");

    expect(localStorage.getItem(agentKey)).toBeNull();
    expect(sessionStorage.getItem(agentKey)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(otherAgentKey)).toBe("keep-agent-b");
    expect(localStorage.getItem("eliza:unrelated")).toBe("keep-me");
  });

  it("clears the legacy global key even without a target agent id", () => {
    localStorage.setItem(LEGACY_KEY, "legacy-key");
    sessionStorage.setItem(LEGACY_KEY, "legacy-key");

    clearCloudPairApiToken();

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("is a safe no-op when the key is absent", () => {
    expect(() => clearCloudPairApiToken("agent-a")).not.toThrow();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("targets the exact keys the write channel uses", async () => {
    // Guards against a silent rename drift between the write channel
    // (CloudPairRelay) and this delete channel: both must share the literal.
    const relay = await import("../components/auth/CloudPairRelay");
    expect(relay.CLOUD_PAIR_SESSION_STORAGE_KEY).toBe(LEGACY_KEY);
    expect(relay.CLOUD_PAIR_LOCAL_STORAGE_KEY).toBe(LEGACY_KEY);
    expect(relay.cloudPairTokenKeyForAgent("agent-a")).toBe(
      "eliza:cloud-pair:api-token:agent-a",
    );
  });
});

describe("clearStalePairCredentialsForAgent", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("purges the per-agent key, active-server token, and ONLY the target agent's profile token", () => {
    const agentKey = cloudPairTokenKeyForAgent("agent-a");
    localStorage.setItem(agentKey, "stale-bearer");
    sessionStorage.setItem(agentKey, "stale-bearer");
    localStorage.setItem(LEGACY_KEY, "legacy-bearer");
    seedActiveServer("agent-a");
    seedProfiles();

    clearStalePairCredentialsForAgent("agent-a");

    expect(localStorage.getItem(agentKey)).toBeNull();
    expect(sessionStorage.getItem(agentKey)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    const active = JSON.parse(
      localStorage.getItem(ACTIVE_SERVER_KEY) ?? "{}",
    ) as { accessToken?: string; apiBase?: string };
    // Server selection survives; only the credential is scrubbed.
    expect(active.accessToken).toBeUndefined();
    expect(active.apiBase).toBe("https://agent-a.elizacloud.ai");
    // Unrelated valid credentials survive the target-agent purge.
    expect(profileTokens()).toEqual({
      p1: undefined,
      p2: "token-b",
      p3: "token-remote",
    });
  });

  it("leaves ANOTHER agent's per-agent key untouched", () => {
    const agentAKey = cloudPairTokenKeyForAgent("agent-a");
    const agentBKey = cloudPairTokenKeyForAgent("agent-b");
    localStorage.setItem(agentAKey, "stale-a");
    localStorage.setItem(agentBKey, "valid-b");
    seedActiveServer("agent-b");
    seedProfiles();

    clearStalePairCredentialsForAgent("agent-b");

    expect(localStorage.getItem(agentBKey)).toBeNull();
    expect(localStorage.getItem(agentAKey)).toBe("stale-a");
    expect(profileTokens()).toEqual({
      p1: "token-a",
      p2: undefined,
      p3: "token-remote",
    });
  });

  it("matches a profile by explicit cloudAgentId / REST-adapter base too", () => {
    seedActiveServer("agent-b");
    seedProfiles();

    clearStalePairCredentialsForAgent("agent-b");

    expect(profileTokens()).toEqual({
      p1: "token-a",
      p2: undefined,
      p3: "token-remote",
    });
  });

  it("leaves the durable key and active-server token alone when the active server is a DIFFERENT agent", () => {
    // The durable key holds whatever bearer boot adoption stamped for the
    // ACTIVE agent; when that is not the proven-stale agent, the key belongs
    // to an unproven credential and must survive.
    const agentAKey = cloudPairTokenKeyForAgent("agent-a");
    localStorage.setItem(agentAKey, "other-agents-bearer");
    seedActiveServer("agent-b");
    seedProfiles();

    clearStalePairCredentialsForAgent("agent-a");

    expect(localStorage.getItem(agentAKey)).toBe("other-agents-bearer");
    const active = JSON.parse(
      localStorage.getItem(ACTIVE_SERVER_KEY) ?? "{}",
    ) as { accessToken?: string };
    expect(active.accessToken).toBe("bearer-agent-b");
    // The proven agent's profile credential is still scrubbed.
    expect(profileTokens()).toEqual({
      p1: undefined,
      p2: "token-b",
      p3: "token-remote",
    });
  });

  it("is a safe no-op for a blank agent id and when nothing is persisted", () => {
    const agentAKey = cloudPairTokenKeyForAgent("agent-a");
    localStorage.setItem(agentAKey, "keep-me");
    clearStalePairCredentialsForAgent("  ");
    expect(localStorage.getItem(agentAKey)).toBe("keep-me");

    localStorage.clear();
    expect(() => clearStalePairCredentialsForAgent("agent-a")).not.toThrow();
  });
});

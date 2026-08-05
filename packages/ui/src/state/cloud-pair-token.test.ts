/** Verifies clearCloudPairApiToken through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Delete channel for the durable cloud-pair API token (#16666): the clear must
 * empty BOTH storages the write channel targets, or the boot adopter
 * (localStorage first, sessionStorage fallback) re-adopts the dead credential
 * on the next launch — and the agent-scoped purge must destroy ONLY the proven
 * agent's credentials, never unrelated profiles. jsdom + real storages; no
 * network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCloudPairApiToken,
  clearStalePairCredentialsForAgent,
} from "./cloud-pair-token";

const KEY = "eliza:cloud-pair:api-token";
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

  it("removes the durable pair token from BOTH storages", () => {
    localStorage.setItem(KEY, "stale-key");
    sessionStorage.setItem(KEY, "stale-key");
    localStorage.setItem("eliza:unrelated", "keep-me");

    clearCloudPairApiToken();

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem("eliza:unrelated")).toBe("keep-me");
  });

  it("is a safe no-op when the key is absent", () => {
    expect(() => clearCloudPairApiToken()).not.toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("targets the exact key the write channel uses", async () => {
    // Guards against a silent rename drift between the write channel
    // (CloudPairRelay) and this delete channel: both must share the literal.
    const relay = await import("../components/auth/CloudPairRelay");
    expect(relay.CLOUD_PAIR_SESSION_STORAGE_KEY).toBe(KEY);
    expect(relay.CLOUD_PAIR_LOCAL_STORAGE_KEY).toBe(KEY);
  });
});

describe("clearStalePairCredentialsForAgent", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("purges the durable key, active-server token, and ONLY the target agent's profile token", () => {
    localStorage.setItem(KEY, "stale-bearer");
    sessionStorage.setItem(KEY, "stale-bearer");
    seedActiveServer("agent-a");
    seedProfiles();

    clearStalePairCredentialsForAgent("agent-a");

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
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
    localStorage.setItem(KEY, "other-agents-bearer");
    seedActiveServer("agent-b");
    seedProfiles();

    clearStalePairCredentialsForAgent("agent-a");

    expect(localStorage.getItem(KEY)).toBe("other-agents-bearer");
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
    localStorage.setItem(KEY, "keep-me");
    clearStalePairCredentialsForAgent("  ");
    expect(localStorage.getItem(KEY)).toBe("keep-me");

    localStorage.clear();
    expect(() => clearStalePairCredentialsForAgent("agent-a")).not.toThrow();
  });
});

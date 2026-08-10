/**
 * Exercises agent-profile token scrubbing, add/upsert/activate behavior, and
 * query resolution against real jsdom storage without a live agent or network.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellLocalStorage } from "../surface-realm-channel";
import {
  activeServerIdForAgentProfile,
  addAgentProfile,
  loadAgentProfileRegistry,
  persistAgentProfileSelection,
  resolveAgentProfileByQuery,
  scrubPersistedAgentProfileTokens,
  upsertAndActivateAgentProfile,
} from "./agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

const CLOUD_AGENT_A_ID = "23766030-c096-4a14-932a-a4e43c562432";
const CLOUD_AGENT_B_ID = "8dba1b08-03be-4f9a-8f63-bd5de03f91e8";
const CLOUD_AGENT_A_SHARED_BASE = `https://api.elizacloud.ai/api/v1/eliza/agents/${CLOUD_AGENT_A_ID}`;

describe("durable agent-profile selection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function seedSelection() {
    const local = addAgentProfile({
      label: "This device",
      kind: "local",
    });
    const cloud = addAgentProfile({
      label: "Cloud agent",
      kind: "cloud",
      cloudAgentId: CLOUD_AGENT_A_ID,
      apiBase: `https://${CLOUD_AGENT_A_ID}.elizacloud.ai`,
      accessToken: "cloud-token",
    });
    const cloudServer = createPersistedActiveServer({
      kind: "cloud",
      id: `cloud:${CLOUD_AGENT_A_ID}`,
      apiBase: cloud.apiBase,
      accessToken: cloud.accessToken,
      label: cloud.label,
    });
    expect(savePersistedActiveServer(cloudServer)).toBe(true);
    return { cloud, cloudServer, local };
  }

  it("updates the registry and boot-authoritative server together", () => {
    const { local } = seedSelection();
    const localServer = createPersistedActiveServer({
      kind: "local",
      id: local.id,
      label: local.label,
    });

    expect(persistAgentProfileSelection(local.id, localServer)).toBe(true);
    expect(loadAgentProfileRegistry().activeProfileId).toBe(local.id);
    expect(loadPersistedActiveServer()?.id).toBe(localServer.id);
  });

  it("does not change the boot target when the registry write fails", () => {
    const { cloudServer, local } = seedSelection();
    const setItem = shellLocalStorage.setItem.bind(shellLocalStorage);
    const writeSpy = vi
      .spyOn(shellLocalStorage, "setItem")
      .mockImplementation((key, value) => {
        if (key === "elizaos:agent-profiles") {
          throw new DOMException("blocked", "SecurityError");
        }
        setItem(key, value);
      });

    try {
      expect(
        persistAgentProfileSelection(
          local.id,
          createPersistedActiveServer({
            kind: "local",
            id: local.id,
            label: local.label,
          }),
        ),
      ).toBe(false);
      expect(loadPersistedActiveServer()?.id).toBe(cloudServer.id);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("rolls back the active profile when the boot-target write fails", () => {
    const { cloud, cloudServer, local } = seedSelection();
    const setItem = shellLocalStorage.setItem.bind(shellLocalStorage);
    const writeSpy = vi
      .spyOn(shellLocalStorage, "setItem")
      .mockImplementation((key, value) => {
        if (key === "elizaos:active-server") {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        setItem(key, value);
      });

    try {
      expect(
        persistAgentProfileSelection(
          local.id,
          createPersistedActiveServer({
            kind: "local",
            id: local.id,
            label: local.label,
          }),
        ),
      ).toBe(false);
      expect(loadAgentProfileRegistry().activeProfileId).toBe(cloud.id);
      expect(loadPersistedActiveServer()?.id).toBe(cloudServer.id);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("Agent profile token scrub", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("drops the access token from every profile on sign-out but keeps the rest", () => {
    const a = addAgentProfile({
      label: "Cloud Agent",
      kind: "cloud",
      apiBase: "https://agent-runtime.example.test",
      accessToken: "jwt-to-scrub",
    });
    const b = addAgentProfile({
      label: "Remote Agent",
      kind: "remote",
      apiBase: "https://remote.example.test",
      accessToken: "another-jwt",
    });

    scrubPersistedAgentProfileTokens();

    const registry = loadAgentProfileRegistry();
    const scrubbedA = registry.profiles.find((p) => p.id === a.id);
    const scrubbedB = registry.profiles.find((p) => p.id === b.id);

    expect(scrubbedA?.accessToken).toBeUndefined();
    expect(scrubbedB?.accessToken).toBeUndefined();
    expect(scrubbedA).toEqual(
      expect.objectContaining({
        id: a.id,
        label: "Cloud Agent",
        kind: "cloud",
        apiBase: "https://agent-runtime.example.test",
      }),
    );
    // Active selection preserved.
    expect(registry.activeProfileId).toBe(b.id);
  });

  it("is a safe no-op when no profiles exist", () => {
    expect(() => scrubPersistedAgentProfileTokens()).not.toThrow();
    expect(loadAgentProfileRegistry().profiles).toHaveLength(0);
  });
});

describe("upsertAndActivateAgentProfile — cross-surface registry sync", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adds and activates a new profile when none matches (kind, apiBase)", () => {
    const p = upsertAndActivateAgentProfile({
      kind: "remote",
      label: "My Server",
      apiBase: "https://remote.example.test",
      accessToken: "jwt-1",
    });
    const registry = loadAgentProfileRegistry();
    expect(registry.profiles).toHaveLength(1);
    expect(registry.activeProfileId).toBe(p.id);
    expect(registry.profiles[0]).toEqual(
      expect.objectContaining({
        kind: "remote",
        apiBase: "https://remote.example.test",
        accessToken: "jwt-1",
      }),
    );
  });

  it("is idempotent: reconnecting to the same host re-activates the SAME profile (no duplicate) and refreshes the token/label", () => {
    // Seed a different active profile first, so re-activation is observable.
    const other = addAgentProfile({ kind: "local", label: "This device" });
    const first = upsertAndActivateAgentProfile({
      kind: "remote",
      label: "My Server",
      apiBase: "https://remote.example.test/",
      accessToken: "jwt-old",
    });
    // Something else becomes active in between.
    upsertAndActivateAgentProfile({ kind: "local", label: "This device" });
    expect(loadAgentProfileRegistry().activeProfileId).toBe(other.id);

    // Reconnect to the same remote host (trailing-slash difference) with a new token.
    const second = upsertAndActivateAgentProfile({
      kind: "remote",
      label: "My Server (renamed)",
      apiBase: "https://remote.example.test",
      accessToken: "jwt-new",
    });

    const registry = loadAgentProfileRegistry();
    expect(second.id).toBe(first.id); // same profile, not a duplicate
    expect(registry.profiles.filter((p) => p.kind === "remote")).toHaveLength(
      1,
    );
    expect(registry.activeProfileId).toBe(first.id); // re-activated
    const remote = registry.profiles.find((p) => p.id === first.id);
    expect(remote?.accessToken).toBe("jwt-new"); // token refreshed
    expect(remote?.label).toBe("My Server (renamed)"); // label refreshed
  });

  it("keeps distinct profiles for distinct hosts of the same kind", () => {
    upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Prod",
      apiBase: "https://prod.agent.example.test",
      accessToken: "jwt-a",
    });
    upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Staging",
      apiBase: "https://staging.agent.example.test",
      accessToken: "jwt-b",
    });
    const registry = loadAgentProfileRegistry();
    expect(registry.profiles.filter((p) => p.kind === "cloud")).toHaveLength(2);
  });

  it("never merges two explicitly-bound Cloud owners that report the same adapter base", () => {
    const agentA = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Agent A",
      cloudAgentId: CLOUD_AGENT_A_ID,
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "token-a",
    });
    const agentB = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Agent B",
      cloudAgentId: CLOUD_AGENT_B_ID,
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "token-b",
    });

    const registry = loadAgentProfileRegistry();
    expect(agentB.id).not.toBe(agentA.id);
    expect(registry.profiles).toHaveLength(2);
    expect(
      registry.profiles.find((profile) => profile.id === agentA.id),
    ).toEqual(
      expect.objectContaining({
        cloudAgentId: CLOUD_AGENT_A_ID,
        accessToken: "token-a",
      }),
    );
    expect(
      registry.profiles.find((profile) => profile.id === agentB.id),
    ).toEqual(
      expect.objectContaining({
        cloudAgentId: CLOUD_AGENT_B_ID,
        accessToken: "token-b",
      }),
    );
  });

  it("uses an authoritative owner id to enrich a matching legacy row without deriving ownership from its host or profile id", () => {
    const legacy = addAgentProfile({
      kind: "cloud",
      label: "Older install",
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "token-old",
    });
    expect(legacy.cloudAgentId).toBeUndefined();

    const rebound = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Agent A",
      cloudAgentId: CLOUD_AGENT_A_ID,
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "token-fresh",
    });

    expect(rebound.id).toBe(legacy.id);
    expect(rebound).toEqual(
      expect.objectContaining({
        cloudAgentId: CLOUD_AGENT_A_ID,
        accessToken: "token-fresh",
      }),
    );
  });

  it("never lets an unbound Cloud upsert overwrite a bound owner's token on the same base", () => {
    const bound = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Agent A",
      cloudAgentId: CLOUD_AGENT_A_ID,
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "token-a",
    });
    const unbound = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Unbound connection",
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "unowned-token",
    });

    const registry = loadAgentProfileRegistry();
    expect(unbound.id).not.toBe(bound.id);
    expect(registry.profiles).toHaveLength(2);
    expect(
      registry.profiles.find((profile) => profile.id === bound.id),
    ).toEqual(
      expect.objectContaining({
        cloudAgentId: CLOUD_AGENT_A_ID,
        accessToken: "token-a",
      }),
    );
  });

  it("reuses one explicitly-bound Cloud owner across a canonical base change", () => {
    const shared = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Agent A",
      cloudAgentId: CLOUD_AGENT_A_ID,
      apiBase: CLOUD_AGENT_A_SHARED_BASE,
      accessToken: "shared-token",
    });
    const dedicatedBase = `https://${CLOUD_AGENT_A_ID}.elizacloud.ai`;
    const dedicated = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Agent A",
      cloudAgentId: CLOUD_AGENT_A_ID,
      apiBase: dedicatedBase,
      accessToken: "dedicated-token",
    });

    expect(dedicated.id).toBe(shared.id);
    expect(loadAgentProfileRegistry().profiles).toHaveLength(1);
    expect(dedicated).toEqual(
      expect.objectContaining({
        cloudAgentId: CLOUD_AGENT_A_ID,
        apiBase: dedicatedBase,
        accessToken: "dedicated-token",
      }),
    );
  });

  it("re-activating without a new token leaves the prior token in place (never blanks it)", () => {
    const p = upsertAndActivateAgentProfile({
      kind: "remote",
      label: "My Server",
      apiBase: "https://remote.example.test",
      accessToken: "keep-me",
    });
    upsertAndActivateAgentProfile({
      kind: "remote",
      label: "My Server",
      apiBase: "https://remote.example.test",
      // no accessToken
    });
    const remote = loadAgentProfileRegistry().profiles.find(
      (x) => x.id === p.id,
    );
    expect(remote?.accessToken).toBe("keep-me");
  });

  it("backfills the explicit Cloud owner when a loopback profile is re-paired", () => {
    const profile = upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Local Docker agent",
      apiBase: "http://127.0.0.1:43123",
      accessToken: "old-token",
    });

    upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Local Docker agent",
      cloudAgentId: "55555555-5555-4555-8555-555555555555",
      apiBase: "http://127.0.0.1:43123",
      accessToken: "fresh-token",
    });

    expect(
      loadAgentProfileRegistry().profiles.find(
        (item) => item.id === profile.id,
      ),
    ).toEqual(
      expect.objectContaining({
        cloudAgentId: "55555555-5555-4555-8555-555555555555",
        accessToken: "fresh-token",
      }),
    );
  });

  it("maps a Cloud profile owner to the restorable active-server identity", () => {
    expect(
      activeServerIdForAgentProfile({
        id: "profile-row-id",
        label: "Local Docker agent",
        kind: "cloud",
        cloudAgentId: "55555555-5555-4555-8555-555555555555",
        apiBase: "http://127.0.0.1:43123",
        createdAt: "2026-08-10T00:00:00.000Z",
      }),
    ).toBe("cloud:55555555-5555-4555-8555-555555555555");
  });
});

describe("resolveAgentProfileByQuery", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("resolves by exact id, exact label, then unique substring", () => {
    const cloud = addAgentProfile({
      label: "My Cloud Agent",
      kind: "cloud",
      apiBase: "https://agent.example.test",
    });
    addAgentProfile({ label: "Laptop", kind: "local", apiBase: "" });

    expect(resolveAgentProfileByQuery(cloud.id)?.id).toBe(cloud.id);
    expect(resolveAgentProfileByQuery("my cloud agent")?.id).toBe(cloud.id);
    // Unique substring of the label.
    expect(resolveAgentProfileByQuery("laptop")?.label).toBe("Laptop");
  });

  it("resolves a unique kind keyword when exactly one profile has it", () => {
    const remote = addAgentProfile({
      label: "VPS",
      kind: "remote",
      apiBase: "https://vps.example.test",
    });
    addAgentProfile({ label: "Laptop", kind: "local", apiBase: "" });

    expect(resolveAgentProfileByQuery("remote")?.id).toBe(remote.id);
  });

  it("returns null when a kind keyword is ambiguous", () => {
    addAgentProfile({ label: "Laptop", kind: "local", apiBase: "" });
    addAgentProfile({ label: "Desktop", kind: "local", apiBase: "" });

    expect(resolveAgentProfileByQuery("local")).toBeNull();
  });

  it("returns null for an ambiguous substring, empty query, or no match", () => {
    addAgentProfile({
      label: "Cloud North",
      kind: "cloud",
      apiBase: "https://n.example.test",
    });
    addAgentProfile({
      label: "Cloud South",
      kind: "cloud",
      apiBase: "https://s.example.test",
    });

    expect(resolveAgentProfileByQuery("cloud")).toBeNull(); // ambiguous substring
    expect(resolveAgentProfileByQuery("   ")).toBeNull();
    expect(resolveAgentProfileByQuery("nonexistent")).toBeNull();
  });
});

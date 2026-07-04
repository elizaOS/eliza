// @vitest-environment jsdom

/**
 * The agent-profile registry (`agent-profiles`): token scrub on sign-out,
 * add/upsert/activate, and query resolution over jsdom `localStorage`. Pure
 * store logic — no live model or network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  resolveAgentProfileByQuery,
  scrubPersistedAgentProfileTokens,
  upsertAndActivateAgentProfile,
} from "./agent-profiles";

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

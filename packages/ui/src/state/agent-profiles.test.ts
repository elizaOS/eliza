// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  scrubPersistedAgentProfileTokens,
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

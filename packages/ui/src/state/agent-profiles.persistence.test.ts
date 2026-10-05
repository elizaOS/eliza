// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addAgentProfile,
  getActiveProfile,
  loadAgentProfileRegistry,
  removeAgentProfile,
  updateAgentProfile,
  upsertAndActivateAgentProfile,
} from "./agent-profiles";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("keeps profile mutations truthful when persistence fails", () => {
  const profile = addAgentProfile({
    kind: "remote",
    label: "Remote",
    apiBase: "https://agent.example",
  });
  const stored = loadAgentProfileRegistry();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota exceeded");
    });
  for (const mutate of [
    () => addAgentProfile({ kind: "local", label: "Local" }),
    () => updateAgentProfile(profile.id, { label: "Changed" }),
    () =>
      upsertAndActivateAgentProfile({
        kind: "remote",
        label: "Reconnected",
        apiBase: "https://agent.example",
      }),
    () => removeAgentProfile(profile.id),
  ]) {
    expect(mutate).toThrow(
      expect.objectContaining({ code: "AGENT_PROFILE_PERSISTENCE_FAILED" }),
    );
    expect(loadAgentProfileRegistry()).toEqual(stored);
  }
  write.mockRestore();
  updateAgentProfile(profile.id, { label: "Changed" });
  expect(getActiveProfile()?.label).toBe("Changed");
});

it("retains an existing single-server connection when upgrading to profiles", () => {
  const saved = JSON.stringify({
    kind: "cloud",
    id: "cloud:personal:owner",
    label: "My agent",
    apiBase: "https://agent.example",
    accessToken: "test-only-saved-token",
    cloudRuntimeAgentId: "runtime-identity",
    cloudRuntime: "dedicated",
  });
  localStorage.setItem("elizaos:active-server", saved);
  const registry = loadAgentProfileRegistry();
  expect(registry.profiles).toHaveLength(1);
  expect(getActiveProfile()).toMatchObject({
    id: registry.activeProfileId,
    kind: "cloud",
    label: "My agent",
    cloudAgentId: "personal:owner",
    cloudRuntimeAgentId: "runtime-identity",
    cloudRuntime: "dedicated",
    apiBase: "https://agent.example",
    accessToken: "test-only-saved-token",
  });
  expect(loadAgentProfileRegistry()).toEqual(registry);
  expect(localStorage.getItem("elizaos:active-server")).toBe(saved);
});

it("does not resurrect an older connection over an existing empty registry", () => {
  const registry = { version: 1, activeProfileId: null, profiles: [] };
  localStorage.setItem("elizaos:agent-profiles", JSON.stringify(registry));
  localStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      kind: "remote",
      id: "old",
      label: "Retired",
      apiBase: "https://old.example",
    }),
  );
  expect(loadAgentProfileRegistry()).toEqual(registry);
});

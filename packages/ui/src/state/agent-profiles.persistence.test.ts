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

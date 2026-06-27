// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // client
  setBaseUrl: vi.fn(),
  repointBaseUrl: vi.fn(),
  setToken: vi.fn(),
  // state / profiles / drafts
  createPersistedActiveServer: vi.fn(
    (args: { id?: string; apiBase?: string; accessToken?: string }) => ({
      id: args.id ?? "cloud:dedicated-1",
      kind: "cloud" as const,
      label: "Dedicated Agent",
      ...(args.apiBase ? { apiBase: args.apiBase } : {}),
      ...(args.accessToken ? { accessToken: args.accessToken } : {}),
    }),
  ),
  savePersistedActiveServer: vi.fn(),
  addAgentProfile: vi.fn((p: Record<string, unknown>) => ({
    ...p,
    id: "profile-dedicated-1",
  })),
  setActiveProfileId: vi.fn(),
  clearAllChatDrafts: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    setBaseUrl: mocks.setBaseUrl,
    repointBaseUrl: mocks.repointBaseUrl,
    setToken: mocks.setToken,
  },
}));

vi.mock("../../state", () => ({
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
  addAgentProfile: mocks.addAgentProfile,
  setActiveProfileId: mocks.setActiveProfileId,
  // Exposed so a regression that re-introduces switchAgentProfile's draft wipe
  // would be caught — the silent re-point must NEVER call this.
  clearAllChatDrafts: mocks.clearAllChatDrafts,
}));

import { silentlyRepointToDedicated } from "./silent-repoint";

const ARGS = {
  containerBase: "https://dedicated-1.elizacloud.ai",
  authToken: "cloud-token",
  dedicatedAgentId: "dedicated-1",
};

describe("silentlyRepointToDedicated", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("re-points the live client SEAMLESSLY (repointBaseUrl, not setBaseUrl)", () => {
    silentlyRepointToDedicated(ARGS);

    // The whole point of PR3: a seamless in-place WS swap, NOT the global
    // setBaseUrl (which hard-disconnects the WS and leaves it dead until a
    // later boot phase reconnects — a visible drop).
    expect(mocks.repointBaseUrl).toHaveBeenCalledTimes(1);
    expect(mocks.repointBaseUrl).toHaveBeenCalledWith(
      "https://dedicated-1.elizacloud.ai",
    );
    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.setToken).toHaveBeenCalledWith("cloud-token");
  });

  it("does NOT clear chat drafts (the composer survives the switch)", () => {
    silentlyRepointToDedicated(ARGS);
    expect(mocks.clearAllChatDrafts).not.toHaveBeenCalled();
  });

  it("persists the dedicated as the restorable active server + active profile", () => {
    silentlyRepointToDedicated(ARGS);

    // Keyed by the dedicated id so a reboot restores the dedicated, not the
    // now-stale shared bridge.
    expect(mocks.createPersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        id: "cloud:dedicated-1",
        apiBase: "https://dedicated-1.elizacloud.ai",
        accessToken: "cloud-token",
      }),
    );
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(mocks.addAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        apiBase: "https://dedicated-1.elizacloud.ai",
        accessToken: "cloud-token",
      }),
    );
    // The dedicated profile is made active WITHOUT switchAgentProfile (so no
    // SWITCH_AGENT dispatch / coordinator re-entry / StartupScreen flash).
    expect(mocks.setActiveProfileId).toHaveBeenCalledWith("profile-dedicated-1");
  });
});

/** Verifies silentlyRepointToDedicated through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `silentlyRepointToDedicated` seamlessly moves the live client onto the
 * dedicated agent without a visible reconnect. Client, state, and profile
 * collaborators are doubled to assert it repoints via `repointBaseUrl` (not the
 * hard `setBaseUrl`) and persists the dedicated agent as the restorable active
 * server + active profile.
 */

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
  upsertAndActivateAgentProfile: vi.fn((p: Record<string, unknown>) => ({
    ...p,
    id: "profile-dedicated-1",
  })),
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
  upsertAndActivateAgentProfile: mocks.upsertAndActivateAgentProfile,
}));

import { silentlyRepointToDedicated } from "./silent-repoint";

const DEDICATED_AGENT_ID = "8dba1b08-03be-4f9a-8f63-bd5de03f91e8";
const ARGS = {
  containerBase: `https://${DEDICATED_AGENT_ID}.elizacloud.ai`,
  authToken: "cloud-token",
  dedicatedAgentId: DEDICATED_AGENT_ID,
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
      `https://${DEDICATED_AGENT_ID}.elizacloud.ai`,
    );
    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.setToken).toHaveBeenCalledWith("cloud-token");
  });

  it("persists the dedicated as the restorable active server + active profile", () => {
    silentlyRepointToDedicated(ARGS);

    expect(mocks.createPersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        id: `cloud:${DEDICATED_AGENT_ID}`,
        apiBase: `https://${DEDICATED_AGENT_ID}.elizacloud.ai`,
        accessToken: "cloud-token",
        cloudRuntimeAgentId: DEDICATED_AGENT_ID,
        cloudRuntime: "dedicated",
      }),
    );
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAndActivateAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        cloudAgentId: DEDICATED_AGENT_ID,
        cloudRuntimeAgentId: DEDICATED_AGENT_ID,
        cloudRuntime: "dedicated",
        apiBase: `https://${DEDICATED_AGENT_ID}.elizacloud.ai`,
        accessToken: "cloud-token",
      }),
    );
  });

  it("never rewrites the dedicated target to a shared REST adapter", () => {
    silentlyRepointToDedicated(ARGS);

    for (const fn of [
      mocks.repointBaseUrl,
      mocks.createPersistedActiveServer,
      mocks.upsertAndActivateAgentProfile,
    ]) {
      expect(JSON.stringify(fn.mock.calls)).not.toContain(
        "/api/v1/eliza/agents/",
      );
    }
  });

  it("retains a rowless personal identity while changing only its runtime", () => {
    const personalElizaId = "personal:00000000-0000-5000-8000-000000000001";

    silentlyRepointToDedicated({ ...ARGS, personalElizaId });

    expect(mocks.createPersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `cloud:${personalElizaId}`,
        cloudRuntimeAgentId: DEDICATED_AGENT_ID,
        cloudRuntime: "dedicated",
      }),
    );
    expect(mocks.upsertAndActivateAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAgentId: personalElizaId,
        cloudRuntimeAgentId: DEDICATED_AGENT_ID,
        cloudRuntime: "dedicated",
      }),
    );
  });
});

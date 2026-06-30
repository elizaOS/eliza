// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "./agent-profile-types";

const mocks = vi.hoisted(() => ({
  setBaseUrl: vi.fn(),
  repointBaseUrl: vi.fn(),
  setToken: vi.fn(),
  loadAgentProfileRegistry: vi.fn(),
  setActiveProfileId: vi.fn(),
  createPersistedActiveServer: vi.fn((args: Record<string, unknown>) => ({
    ...args,
  })),
  savePersistedActiveServer: vi.fn(),
  isTrustedRestoreApiBaseUrl: vi.fn(() => true),
}));

vi.mock("../api", () => ({
  client: {
    setBaseUrl: mocks.setBaseUrl,
    repointBaseUrl: mocks.repointBaseUrl,
    setToken: mocks.setToken,
  },
}));
vi.mock("./agent-profiles", () => ({
  loadAgentProfileRegistry: mocks.loadAgentProfileRegistry,
  setActiveProfileId: mocks.setActiveProfileId,
}));
vi.mock("./persistence", () => ({
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
}));
vi.mock("./startup-phase-restore", () => ({
  isTrustedRestoreApiBaseUrl: mocks.isTrustedRestoreApiBaseUrl,
}));

import { switchRuntimeNonDestructive } from "./switch-runtime";

const LOCAL: AgentProfile = {
  id: "local-1",
  label: "This device",
  kind: "local",
  createdAt: "2026-06-01T00:00:00.000Z",
};
const CLOUD: AgentProfile = {
  id: "cloud-1",
  label: "Cloud agent",
  kind: "cloud",
  apiBase: "https://x.agent.elizacloud.ai",
  accessToken: "tok-cloud",
  createdAt: "2026-06-02T00:00:00.000Z",
};
const REMOTE: AgentProfile = {
  id: "vps-1",
  label: "My VPS",
  kind: "remote",
  apiBase: "http://100.72.1.4:3000",
  accessToken: "tok-vps",
  createdAt: "2026-06-03T00:00:00.000Z",
};

function withRegistry(profiles: AgentProfile[]) {
  mocks.loadAgentProfileRegistry.mockReturnValue({
    version: 1,
    activeProfileId: profiles[0]?.id ?? null,
    profiles,
  });
}

describe("switchRuntimeNonDestructive", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockClear();
    mocks.isTrustedRestoreApiBaseUrl.mockReturnValue(true);
    mocks.createPersistedActiveServer.mockImplementation((a) => ({ ...a }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns not-found for an unknown id and touches nothing", () => {
    withRegistry([LOCAL]);
    expect(switchRuntimeNonDestructive("nope")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(mocks.repointBaseUrl).not.toHaveBeenCalled();
  });

  it("switches to a cloud runtime: persists, activates, re-points seamlessly (not setBaseUrl)", () => {
    withRegistry([LOCAL, CLOUD]);
    const res = switchRuntimeNonDestructive("cloud-1");
    expect(res).toEqual({ ok: true, profile: CLOUD });
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(mocks.setActiveProfileId).toHaveBeenCalledWith("cloud-1");
    expect(mocks.setToken).toHaveBeenCalledWith("tok-cloud");
    expect(mocks.repointBaseUrl).toHaveBeenCalledWith(
      "https://x.agent.elizacloud.ai",
    );
    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
  });

  it("switches to a local runtime: persists + activates, NO re-point (same-origin)", () => {
    withRegistry([LOCAL, CLOUD]);
    const res = switchRuntimeNonDestructive("local-1");
    expect(res.ok).toBe(true);
    expect(mocks.setActiveProfileId).toHaveBeenCalledWith("local-1");
    expect(mocks.repointBaseUrl).not.toHaveBeenCalled();
    expect(mocks.setToken).not.toHaveBeenCalled();
  });

  it("rejects an untrusted remote (public URL) without switching", () => {
    mocks.isTrustedRestoreApiBaseUrl.mockReturnValue(false);
    withRegistry([LOCAL, REMOTE]);
    expect(switchRuntimeNonDestructive("vps-1")).toEqual({
      ok: false,
      reason: "untrusted-remote",
    });
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(mocks.repointBaseUrl).not.toHaveBeenCalled();
  });

  it("allows a trusted remote (tailscale/RFC1918) and re-points", () => {
    mocks.isTrustedRestoreApiBaseUrl.mockReturnValue(true);
    withRegistry([LOCAL, REMOTE]);
    const res = switchRuntimeNonDestructive("vps-1");
    expect(res.ok).toBe(true);
    expect(mocks.repointBaseUrl).toHaveBeenCalledWith("http://100.72.1.4:3000");
    expect(mocks.setToken).toHaveBeenCalledWith("tok-vps");
  });
});

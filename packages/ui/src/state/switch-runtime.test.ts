/**
 * Exercises non-destructive runtime switching across the client, active
 * profile, restorable server, and composer-draft boundaries with jsdom storage.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "./agent-profile-types";

const mocks = vi.hoisted(() => ({
  setBaseUrl: vi.fn(),
  repointBaseUrl: vi.fn(),
  setToken: vi.fn(),
  loadAgentProfileRegistry: vi.fn(),
  setActiveProfileId: vi.fn(),
  activeServerIdForAgentProfile: vi.fn((profile: AgentProfile) =>
    profile.kind === "cloud" && profile.cloudAgentId
      ? `cloud:${profile.cloudAgentId}`
      : profile.id,
  ),
  createPersistedActiveServer: vi.fn((args: Record<string, unknown>) => ({
    ...args,
  })),
  savePersistedActiveServer: vi.fn(),
  isTrustedRestoreApiBaseUrl: vi.fn(() => true),
  clearAllChatDrafts: vi.fn(),
  getFrontendPlatform: vi.fn(() => "web"),
  isMobileLocalAgentIpcBase: vi.fn(() => false),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
  activeServerKindToFirstRunRuntimeTarget: vi.fn((k: string) =>
    k === "cloud" ? "elizacloud" : "remote",
  ),
}));

vi.mock("../api", () => ({
  client: {
    setBaseUrl: mocks.setBaseUrl,
    repointBaseUrl: mocks.repointBaseUrl,
    setToken: mocks.setToken,
  },
}));
vi.mock("./agent-profiles", () => ({
  activeServerIdForAgentProfile: mocks.activeServerIdForAgentProfile,
  loadAgentProfileRegistry: mocks.loadAgentProfileRegistry,
  setActiveProfileId: mocks.setActiveProfileId,
}));
vi.mock("./persistence", () => ({
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
}));
vi.mock("./runtime-url-trust", () => ({
  isTrustedRestoreApiBaseUrl: mocks.isTrustedRestoreApiBaseUrl,
}));
vi.mock("./ChatComposerContext.hooks", () => ({
  clearAllChatDrafts: mocks.clearAllChatDrafts,
}));
vi.mock("../platform/platform-guards", () => ({
  getFrontendPlatform: mocks.getFrontendPlatform,
}));
vi.mock("../first-run/mobile-runtime-mode", () => ({
  isMobileLocalAgentIpcBase: mocks.isMobileLocalAgentIpcBase,
  persistMobileRuntimeModeForServerTarget:
    mocks.persistMobileRuntimeModeForServerTarget,
}));
vi.mock("../first-run/runtime-target", () => ({
  activeServerKindToFirstRunRuntimeTarget:
    mocks.activeServerKindToFirstRunRuntimeTarget,
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
const LOCAL_DOCKER_CLOUD: AgentProfile = {
  id: "profile-local-docker",
  label: "Local Docker agent",
  kind: "cloud",
  cloudAgentId: "55555555-5555-4555-8555-555555555555",
  apiBase: "http://127.0.0.1:43123",
  accessToken: "tok-local-agent",
  createdAt: "2026-08-10T00:00:00.000Z",
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
    mocks.getFrontendPlatform.mockReturnValue("web");
    mocks.isMobileLocalAgentIpcBase.mockReturnValue(false);
    mocks.activeServerKindToFirstRunRuntimeTarget.mockImplementation((k) =>
      k === "cloud" ? "elizacloud" : "remote",
    );
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

  it("persists a local-Docker Cloud profile with its platform agent identity", () => {
    withRegistry([LOCAL, LOCAL_DOCKER_CLOUD]);

    switchRuntimeNonDestructive(LOCAL_DOCKER_CLOUD.id);

    expect(mocks.createPersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        id: "cloud:55555555-5555-4555-8555-555555555555",
        apiBase: "http://127.0.0.1:43123",
        accessToken: "tok-local-agent",
      }),
    );
  });

  it("switches to a local runtime: persists + activates + re-points same-origin + clears the stale token", () => {
    withRegistry([LOCAL, CLOUD]);
    const res = switchRuntimeNonDestructive("local-1");
    expect(res.ok).toBe(true);
    expect(mocks.setActiveProfileId).toHaveBeenCalledWith("local-1");
    // local is same-origin: re-point to the app host + drop any prior
    // remote/cloud bearer (regression guard for the stale-base/token bug).
    expect(mocks.repointBaseUrl).toHaveBeenCalledWith(window.location.origin);
    expect(mocks.setToken).toHaveBeenCalledWith(null);
    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
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

  it("switching to a TOKENLESS remote CLEARS the token (no inherited bearer)", () => {
    mocks.isTrustedRestoreApiBaseUrl.mockReturnValue(true);
    const tokenless: AgentProfile = {
      id: "vps-2",
      label: "Tokenless VPS",
      kind: "remote",
      apiBase: "http://100.72.1.9:3000",
      createdAt: "2026-06-04T00:00:00.000Z",
    };
    withRegistry([CLOUD, tokenless]);
    const res = switchRuntimeNonDestructive("vps-2");
    expect(res.ok).toBe(true);
    expect(mocks.repointBaseUrl).toHaveBeenCalledWith("http://100.72.1.9:3000");
    // must CLEAR — not keep the prior cloud bearer (cross-backend leak guard).
    expect(mocks.setToken).toHaveBeenCalledWith(null);
  });

  it("clears chat drafts on a switch (no cross-runtime draft bleed)", () => {
    withRegistry([LOCAL, CLOUD]);
    switchRuntimeNonDestructive("cloud-1");
    expect(mocks.clearAllChatDrafts).toHaveBeenCalledTimes(1);
  });

  it("on mobile, persists the runtime-mode so the switch survives a reboot", () => {
    mocks.getFrontendPlatform.mockReturnValue("android");
    withRegistry([LOCAL, CLOUD]);
    switchRuntimeNonDestructive("cloud-1");
    expect(mocks.persistMobileRuntimeModeForServerTarget).toHaveBeenCalledWith(
      "elizacloud",
    );
  });

  it("does NOT persist mobile runtime-mode on web", () => {
    mocks.getFrontendPlatform.mockReturnValue("web");
    withRegistry([LOCAL, CLOUD]);
    switchRuntimeNonDestructive("cloud-1");
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
  });
});

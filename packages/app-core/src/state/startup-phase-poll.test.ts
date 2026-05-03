import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import type { PlatformPolicy, StartupEvent } from "./startup-coordinator";
import {
  type PollingBackendDeps,
  runPollingBackend,
} from "./startup-phase-poll";

const POLICY: PlatformPolicy = {
  supportsLocalRuntime: true,
  backendTimeoutMs: 1_000,
  agentReadyTimeoutMs: 1_000,
  probeForExistingInstall: false,
  defaultTarget: "embedded-local",
};

function createDeps(): PollingBackendDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setOnboardingComplete: vi.fn(),
    setOnboardingLoading: vi.fn(),
    setOnboardingOptions: vi.fn(),
    setOnboardingStep: vi.fn(),
    setOnboardingServerTarget: vi.fn(),
    setOnboardingCloudApiKey: vi.fn(),
    setOnboardingProvider: vi.fn(),
    setOnboardingVoiceProvider: vi.fn(),
    setOnboardingApiKey: vi.fn(),
    setOnboardingPrimaryModel: vi.fn(),
    setOnboardingOpenRouterModel: vi.fn(),
    setOnboardingRemoteConnected: vi.fn(),
    setOnboardingRemoteApiBase: vi.fn(),
    setOnboardingRemoteToken: vi.fn(),
    setOnboardingSmallModel: vi.fn(),
    setOnboardingLargeModel: vi.fn(),
    setOnboardingCloudProvisionedContainer: vi.fn(),
    setPairingEnabled: vi.fn(),
    setPairingExpiresAt: vi.fn(),
    applyDetectedProviders: vi.fn(),
    onboardingCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

async function runOnce(deps: PollingBackendDeps): Promise<StartupEvent[]> {
  const events: StartupEvent[] = [];
  const effectRunRef = { current: 1 };
  await runPollingBackend(
    deps,
    (event) => events.push(event),
    POLICY,
    null,
    1,
    effectRunRef,
    { current: false },
    { current: null },
  );
  return events;
}

describe("runPollingBackend auth gates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes remote password auth to pairing instead of completing startup", async () => {
    vi.spyOn(client, "hasToken").mockReturnValue(false);
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: true,
      authenticated: false,
      loginRequired: true,
      localAccess: false,
      passwordConfigured: true,
      pairingEnabled: false,
      expiresAt: null,
    });

    const deps = createDeps();
    const events = await runOnce(deps);

    expect(deps.setAuthRequired).toHaveBeenCalledWith(true);
    expect(deps.setPairingEnabled).toHaveBeenCalledWith(false);
    expect(deps.setPairingExpiresAt).toHaveBeenCalledWith(null);
    expect(deps.setOnboardingComplete).not.toHaveBeenCalledWith(true);
    expect(events).toEqual([{ type: "BACKEND_AUTH_REQUIRED" }]);
  });

  it("preserves pairing metadata for remote static-token auth", async () => {
    const expiresAt = Date.now() + 60_000;
    vi.spyOn(client, "hasToken").mockReturnValue(false);
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: true,
      authenticated: false,
      loginRequired: false,
      localAccess: false,
      passwordConfigured: false,
      pairingEnabled: true,
      expiresAt,
    });

    const deps = createDeps();
    const events = await runOnce(deps);

    expect(deps.setAuthRequired).toHaveBeenCalledWith(true);
    expect(deps.setPairingEnabled).toHaveBeenCalledWith(true);
    expect(deps.setPairingExpiresAt).toHaveBeenCalledWith(expiresAt);
    expect(events).toEqual([{ type: "BACKEND_AUTH_REQUIRED" }]);
  });

  it("routes cloud bootstrap auth to bootstrap onboarding instead of pairing", async () => {
    vi.spyOn(client, "hasToken").mockReturnValue(false);
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: true,
      authenticated: false,
      loginRequired: false,
      bootstrapRequired: true,
      localAccess: false,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });

    const deps = createDeps();
    const events = await runOnce(deps);

    expect(deps.setAuthRequired).toHaveBeenCalledWith(false);
    expect(deps.setOnboardingCloudProvisionedContainer).toHaveBeenCalledWith(
      true,
    );
    expect(deps.setOnboardingComplete).toHaveBeenCalledWith(false);
    expect(deps.setPairingEnabled).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "BACKEND_REACHED", onboardingComplete: false },
    ]);
  });

  it("does not treat onboarding 401 as completed startup", async () => {
    const expiresAt = Date.now() + 60_000;
    vi.spyOn(client, "hasToken").mockReturnValue(false);
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: false,
      authenticated: false,
      loginRequired: true,
      localAccess: false,
      passwordConfigured: true,
      pairingEnabled: true,
      expiresAt,
    });
    vi.spyOn(client, "getOnboardingStatus").mockRejectedValue({
      kind: "http",
      status: 401,
      path: "/api/onboarding/status",
      message: "Unauthorized",
    });

    const deps = createDeps();
    const events = await runOnce(deps);

    expect(deps.setAuthRequired).toHaveBeenCalledWith(true);
    expect(deps.setPairingEnabled).toHaveBeenCalledWith(true);
    expect(deps.setPairingExpiresAt).toHaveBeenCalledWith(expiresAt);
    expect(deps.setOnboardingComplete).not.toHaveBeenCalledWith(true);
    expect(events).toEqual([{ type: "BACKEND_AUTH_REQUIRED" }]);
  });
});

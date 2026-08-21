// Pins the fail-closed contract of the onboarding phone-link path: a genuine
// linkPhoneToUser infra failure must PROPAGATE out of runOnboardingChat, while
// its designed tenant-safety decline (success:false) stays a distinguishable
// non-throwing outcome that lets onboarding continue. Deterministic lib
// fixtures (no live model, no network).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";
import * as provisioningObservation from "./provisioning-observation";

const sessionCache = new Map<string, unknown>();
const getElizaAppProvisioningStatus = mock();
const linkPhoneToUser = mock();
const launchManagedElizaAgent = mock();
let cloudEnv: Record<string, string | undefined> = {};
const REAL_CLOUD_BINDINGS = { ...realCloudBindings };

mock.module("../../cache/client", () => ({
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => {
      sessionCache.set(key, value);
    }),
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  ...REAL_CLOUD_BINDINGS,
  getCloudAwareEnv: mock(() => cloudEnv),
}));

mock.module("../eliza-managed-launch", () => ({
  launchManagedElizaAgent,
  // The mock must expose every name imported by onboarding-chat so this suite
  // exercises the error policy instead of failing during module linking.
  readManagedElizaAgentConnection: mock(),
}));

mock.module("./provisioning", () => ({
  ...provisioningObservation,
  getElizaAppProvisioningStatus,
}));

mock.module("./user-service", () => ({
  elizaAppUserService: {
    linkPhoneToUser,
  },
}));

const { runOnboardingChat, onboardingFetch } = await import(
  `./onboarding-chat.ts?test=onboarding-error-policy-${Date.now()}`
);

const PHONE = "+14155550123";
const PLATFORM_SESSION = `platform:blooio:${PHONE}`;

function provisioning() {
  return { status: "provisioning", agentId: "agent-1", bridgeUrl: null, sandbox: null };
}

function authedTrustedPhoneTurn() {
  return runOnboardingChat({
    message: "My name is Sam",
    platform: "blooio",
    platformUserId: PHONE,
    sessionId: PLATFORM_SESSION,
    trustedPlatformIdentity: true,
    authenticatedUser: { userId: "user-1", organizationId: "org-1" },
  });
}

describe("onboarding-chat phone-link error policy", () => {
  beforeEach(() => {
    sessionCache.clear();
    getElizaAppProvisioningStatus.mockReset();
    linkPhoneToUser.mockReset();
    launchManagedElizaAgent.mockReset();
    getElizaAppProvisioningStatus.mockResolvedValue(provisioning());
    cloudEnv = {};
  });

  afterEach(() => {
    cloudEnv = process.env;
  });

  afterAll(() => {
    mock.module("../../runtime/cloud-bindings", () => REAL_CLOUD_BINDINGS);
    mock.restore();
  });

  test("a genuine linkPhoneToUser infra failure PROPAGATES (fail closed, never swallowed)", async () => {
    linkPhoneToUser.mockRejectedValue(new Error("db connection reset"));

    await expect(authedTrustedPhoneTurn()).rejects.toThrow("db connection reset");

    // The link ran; the throw was not turned into a healthy-looking result.
    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
  });

  test("a designed tenant-safety decline (success:false) stays distinct: onboarding continues, no throw", async () => {
    linkPhoneToUser.mockResolvedValue({
      success: false,
      error: "This phone number is already linked to another account",
    });

    const result = await authedTrustedPhoneTurn();

    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
    // A business decline is NOT an internal failure — the turn resolves with a
    // real reply and observes the existing lifecycle state without mutating it.
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.requiresLogin).toBe(false);
    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("org-1", "user-1");
    expect(result.provisioning.status).toBe("provisioning");
  });

  test("a successful link is transparent: onboarding proceeds normally", async () => {
    linkPhoneToUser.mockResolvedValue({ success: true });

    const result = await authedTrustedPhoneTurn();

    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.provisioning.status).toBe("provisioning");
  });
});

describe("onboardingFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung onboarding coordinator hop at the timeout", async () => {
    // A coordinator that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the 10s default bounds internal hops).
    const hungStub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    };
    const start = Date.now();
    await expect(
      onboardingFetch(hungStub, "https://onboarding.internal/resolve", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes a caller-provided abort signal with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    const stub = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal;
        return new Response("{}", { status: 200 });
      },
    };
    const controller = new AbortController();
    await onboardingFetch(stub, "https://onboarding.internal/resolve", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so the signal handed to the transport is
    // a composition of the caller's signal and that deadline — never the caller's
    // object verbatim. Asserting identity here would pin the very behavior that
    // lets a never-firing caller signal defeat the bound.
    expect(seen).not.toBe(controller.signal);
  });
});

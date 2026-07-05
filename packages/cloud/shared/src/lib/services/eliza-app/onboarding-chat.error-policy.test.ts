// Pins the fail-closed contract of the onboarding phone-link path: a genuine
// linkPhoneToUser infra failure must PROPAGATE out of runOnboardingChat, while
// its designed tenant-safety decline (success:false) stays a distinguishable
// non-throwing outcome that lets onboarding continue. Deterministic lib
// fixtures (no live model, no network).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";

const sessionCache = new Map<string, unknown>();
const ensureElizaAppProvisioning = mock();
const getElizaAppProvisioningStatus = mock();
const linkPhoneToUser = mock();
const generateText = mock();
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

mock.module("@ai-sdk/openai", () => ({
  createOpenAI: mock(() => ({ chat: mock(() => "mock-model") })),
  openai: mock(() => "mock-openai-model"),
}));

mock.module("ai", () => ({
  generateText,
}));

mock.module("../eliza-managed-launch", () => ({
  launchManagedElizaAgent,
}));

mock.module("./provisioning", () => ({
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
}));

mock.module("./user-service", () => ({
  elizaAppUserService: {
    linkPhoneToUser,
  },
}));

const { runOnboardingChat } = await import(
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
    ensureElizaAppProvisioning.mockReset();
    getElizaAppProvisioningStatus.mockReset();
    linkPhoneToUser.mockReset();
    generateText.mockReset();
    launchManagedElizaAgent.mockReset();
    ensureElizaAppProvisioning.mockResolvedValue(provisioning());
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
    // Fail-closed on the link means we never advanced to provisioning this turn.
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("a designed tenant-safety decline (success:false) stays distinct: onboarding continues, no throw", async () => {
    linkPhoneToUser.mockResolvedValue({
      success: false,
      error: "This phone number is already linked to another account",
    });

    const result = await authedTrustedPhoneTurn();

    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
    // A business decline is NOT an internal failure — the turn resolves with a
    // real reply and proceeds through provisioning.
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.requiresLogin).toBe(false);
    expect(ensureElizaAppProvisioning).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
    });
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

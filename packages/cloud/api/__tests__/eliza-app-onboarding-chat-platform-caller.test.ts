/**
 * Verifies that a trusted platform gateway calling the onboarding chat route
 * gets the cloud account resolved server-side from the platform identity it
 * attests, never from anything it puts in the request body, and gets a response
 * stripped of the agent-launch credential and transcript it has no use for.
 *
 * The route and the onboarding state machine run for real; only the DB read,
 * the container provisioner, and the session cache are substituted.
 */

import {
  beforeEach,
  describe,
  expect,
  type Mock,
  mock,
  spyOn,
  test,
} from "bun:test";
import { usersRepository } from "@/db/repositories/users";
import type { User } from "@/db/schemas/users";
import { elizaAppSessionService } from "@/lib/services/eliza-app";

const ensureElizaAppProvisioning = mock(async () => ({
  status: "pending",
  agentId: "sandbox-1",
  bridgeUrl: null,
  sandbox: null,
}));
const getElizaAppProvisioningStatus = mock(async () => ({
  status: "none",
  agentId: null,
  bridgeUrl: null,
  sandbox: null,
}));

const sessionCache = new Map<string, unknown>();

mock.module("@/lib/cache/client", () => ({
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => {
      sessionCache.set(key, value);
    }),
  },
}));

mock.module("@/lib/services/eliza-app/provisioning", () => ({
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
  publicElizaAppProvisioningPayload: (status: {
    status: string;
    agentId: string | null;
    bridgeUrl: string | null;
  }) => ({
    status: status.status,
    ...(status.agentId ? { agentId: status.agentId } : {}),
    ...(status.bridgeUrl ? { bridgeUrl: status.bridgeUrl } : {}),
  }),
}));

mock.module("@/lib/services/eliza-app/eliza-managed-launch", () => ({
  launchManagedElizaAgent: mock(async () => ({
    launchUrl: "https://app.elizacloud.ai/launch?cloudLaunchSession=secret",
  })),
}));

mock.module("@/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => null),
    linkPhoneToUser: mock(async () => ({ success: true })),
  },
}));

const route = (await import("../eliza-app/onboarding/chat/route")).default;

const INTERNAL_SECRET = "internal-secret-for-test";

function userRow(overrides: Partial<User> = {}): User {
  return {
    id: "user-9",
    organization_id: "org-9",
    email: "ada@example.com",
    role: "owner",
    wallet_address: null,
    steward_user_id: null,
    is_active: true,
    ...overrides,
  } as unknown as User;
}

async function post(
  body: Record<string, unknown>,
  authorization = `Bearer ${INTERNAL_SECRET}`,
): Promise<Response> {
  return await route.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify(body),
    },
    { INTERNAL_SECRET },
  );
}

async function dataOf(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { data: Record<string, unknown> };
  return body.data;
}

function continuationFromReply(reply: unknown): string {
  if (typeof reply !== "string") {
    throw new Error("Expected the onboarding reply to contain a login URL");
  }
  const match = reply.match(/https:\/\/\S+/);
  if (!match) throw new Error("Expected a login URL in the onboarding reply");
  const token = new URL(match[0]).searchParams.get("onboardingSession");
  if (!token) throw new Error("Expected an onboarding continuation token");
  return token;
}

describe("onboarding chat — trusted platform gateway caller", () => {
  let resolveIdentity: Mock<typeof usersRepository.resolveIdentity>;

  beforeEach(() => {
    sessionCache.clear();
    ensureElizaAppProvisioning.mockClear();
    getElizaAppProvisioningStatus.mockClear();
    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue(null);
    resolveIdentity = spyOn(usersRepository, "resolveIdentity");
    resolveIdentity.mockClear();
  });

  test("provisions for the account that owns the attested platform identity", async () => {
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });

    const response = await post({
      sessionId: "platform:telegram:9911",
      message: "Hello",
      platform: "telegram",
      platformUserId: "9911",
      platformDisplayName: "Ada",
    });

    expect(response.status).toBe(200);
    expect(resolveIdentity).toHaveBeenCalledWith("9911", "telegram");
    expect(ensureElizaAppProvisioning).toHaveBeenCalledWith({
      userId: "user-9",
      organizationId: "org-9",
    });
    expect(await dataOf(response)).toMatchObject({
      requiresLogin: false,
      provisioning: { status: "pending", agentId: "sandbox-1" },
    });
  });

  test("ignores a userId and organizationId claimed in the request body", async () => {
    // `chatSchema` has no such keys today and zod strips unknowns, so this is a
    // regression pin: if anyone ever adds them, the resolved account must still
    // win over the claimed one.
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });

    await post({
      sessionId: "platform:telegram:9911",
      message: "Hello",
      platform: "telegram",
      platformUserId: "9911",
      platformDisplayName: "Ada",
      userId: "attacker-user",
      organizationId: "victim-org",
    });

    expect(ensureElizaAppProvisioning).toHaveBeenCalledWith({
      userId: "user-9",
      organizationId: "org-9",
    });
  });

  test("omits the launch credential, control panel and transcript for a gateway caller", async () => {
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });

    const data = await dataOf(
      await post({
        sessionId: "platform:telegram:9911",
        message: "Hello",
        platform: "telegram",
        platformUserId: "9911",
        platformDisplayName: "Ada",
      }),
    );

    expect(typeof data.reply).toBe("string");
    expect(data).not.toHaveProperty("launchUrl");
    expect(data).not.toHaveProperty("controlPanelUrl");
    expect(data).not.toHaveProperty("loginUrl");
    expect(data).not.toHaveProperty("messages");
  });

  test("keeps the full payload for a browser session caller", async () => {
    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
      userId: "user-9",
      organizationId: "org-9",
    });

    const data = await dataOf(
      await post(
        { message: "Hello", platform: "web" },
        "Bearer browser-session",
      ),
    );

    expect(data).toHaveProperty("loginUrl");
    expect(data).toHaveProperty("controlPanelUrl");
    expect(data).toHaveProperty("messages");
    expect(Array.isArray(data.messages)).toBe(true);
  });

  test("requires a matching signed Telegram session before browser handoff", async () => {
    resolveIdentity.mockResolvedValue(null);
    const gatewayData = await dataOf(
      await post({
        sessionId: "platform:telegram:9913",
        message: "My name is Ada",
        platform: "telegram",
        platformUserId: "9913",
        platformDisplayName: "Ada",
      }),
    );
    const continuation = continuationFromReply(gatewayData.reply);

    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
      userId: "user-9",
      organizationId: "org-9",
      telegramId: "different-telegram-user",
    });
    const mismatch = await post(
      {
        sessionId: continuation,
        platform: "telegram",
      },
      "Bearer browser-session",
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();

    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
      userId: "user-9",
      organizationId: "org-9",
      telegramId: "9913",
    });
    const matched = await post(
      {
        sessionId: continuation,
        platform: "telegram",
      },
      "Bearer browser-session",
    );
    expect(matched.status).toBe(200);
    const matchedData = await dataOf(matched.clone());
    expect(matchedData).toMatchObject({
      requiresLogin: false,
    });
    expect(matchedData).not.toHaveProperty("continuationRedeemed");
    expect(ensureElizaAppProvisioning).toHaveBeenCalledWith({
      userId: "user-9",
      organizationId: "org-9",
    });
  });

  test("maps twilio and blooio onto the phone identity provider", async () => {
    resolveIdentity.mockResolvedValue(null);

    await post({
      sessionId: "platform:twilio:+15551234567",
      message: "Hello",
      platform: "twilio",
      platformUserId: "+15551234567",
    });
    expect(resolveIdentity).toHaveBeenLastCalledWith("+15551234567", "phone");

    await post({
      sessionId: "platform:blooio:+15551234568",
      message: "Hello",
      platform: "blooio",
      platformUserId: "+15551234568",
    });
    expect(resolveIdentity).toHaveBeenLastCalledWith("+15551234568", "phone");
  });

  test("falls back to anonymous onboarding when the platform identity is unknown", async () => {
    resolveIdentity.mockResolvedValue(null);

    const data = await dataOf(
      await post({
        sessionId: "platform:telegram:404",
        message: "Hello",
        platform: "telegram",
        platformUserId: "404",
        platformDisplayName: "Nobody",
      }),
    );

    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(data.requiresLogin).toBe(true);
    // The gateway no longer receives loginUrl as a field; the link the user
    // needs is inside the reply it delivers.
    expect(data.reply).toContain("/get-started");
  });

  test("treats a user without an organization as unresolved", async () => {
    resolveIdentity.mockResolvedValue({
      user: userRow({ organization_id: null }),
      identity: undefined,
    });

    const data = await dataOf(
      await post({
        sessionId: "platform:telegram:9912",
        message: "Hello",
        platform: "telegram",
        platformUserId: "9912",
        platformDisplayName: "Orphan",
      }),
    );

    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(data.requiresLogin).toBe(true);
  });

  test("refuses to resolve an account from a web platform or a bare identifier", async () => {
    // Without a known provider `resolveIdentity` sniffs the identifier's shape
    // and would match a UUID, an email or a wallet address. A gateway can only
    // attest a messaging identity, so an unrecognised platform resolves to
    // nobody rather than to whoever that string happens to name.
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });

    const data = await dataOf(
      await post({
        sessionId: "platform:web:ada@example.com",
        message: "Hello",
        platform: "web",
        platformUserId: "ada@example.com",
      }),
    );

    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(data.requiresLogin).toBe(true);
  });

  test("rejects a caller whose Authorization header is neither a session nor the internal secret", async () => {
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });

    const response = await post({ message: "Hello" }, "Bearer nonsense");

    expect(response.status).toBe(400);
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });
});

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

const linkDiscordToUser = mock(async () => ({ success: true }));
mock.module("@/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => null),
    linkPhoneToUser: mock(async () => ({ success: true })),
    linkDiscordToUser,
  },
}));

// Steward auth is substituted at the module seam: the route imports only
// `getCurrentUser`, and the real implementation would reach for KV caches and
// the Steward verify env. Every other export passes through unchanged.
const realWorkersHonoAuth = await import("@/lib/auth/workers-hono-auth");
const getCurrentUser = mock(async () => null as unknown);
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realWorkersHonoAuth,
  getCurrentUser,
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

async function get(
  sessionId: string,
  authorization: string,
): Promise<Response> {
  return await route.request(
    `/?sessionId=${encodeURIComponent(sessionId)}`,
    { method: "GET", headers: { authorization } },
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
    getCurrentUser.mockReset();
    getCurrentUser.mockResolvedValue(null);
    linkDiscordToUser.mockClear();
  });

  test("reads status for the account that owns the attested platform identity without provisioning", async () => {
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
    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("org-9");
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(await dataOf(response)).toMatchObject({
      requiresLogin: false,
      provisioning: { status: "none" },
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

    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("org-9");
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
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
    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("org-9");
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("requires a matching signed Discord session before browser handoff", async () => {
    resolveIdentity.mockResolvedValue(null);
    await post({
      sessionId: "platform:discord:777123",
      message: "My name is Ada",
      platform: "discord",
      platformUserId: "777123",
      platformDisplayName: "Ada",
    });
    // Discord replies carry the login URL on the CTA, not inline, so read the
    // opaque continuation credential from the stored session.
    const stored = sessionCache.get(
      "eliza-app:onboarding:platform:discord:777123",
    ) as { continuationToken?: string };
    const continuation = stored?.continuationToken;
    if (!continuation) throw new Error("Expected a Discord continuation token");

    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
      userId: "user-9",
      organizationId: "org-9",
      discordId: "different-discord-user",
    });
    const mismatchedPreview = await get(continuation, "Bearer browser-session");
    expect(mismatchedPreview.status).toBe(403);
    expect(await mismatchedPreview.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
    const mismatch = await post(
      {
        sessionId: continuation,
        platform: "discord",
      },
      "Bearer browser-session",
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
    expect(linkDiscordToUser).not.toHaveBeenCalled();
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();

    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
      userId: "user-9",
      organizationId: "org-9",
      discordId: "777123",
    });
    const matched = await post(
      {
        sessionId: continuation,
        platform: "discord",
      },
      "Bearer browser-session",
    );
    expect(matched.status).toBe(200);
    expect(await dataOf(matched)).toMatchObject({
      requiresLogin: false,
    });
    // The signed-id match is the ownership proof; the identity is already
    // linked, so the turn binds and reads status without a re-link or provision.
    expect(linkDiscordToUser).not.toHaveBeenCalled();
    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("org-9");
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
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

  test("preserves a trusted iMessage reply address for the browser return link", async () => {
    resolveIdentity.mockResolvedValue(null);
    const gatewayData = await dataOf(
      await post({
        sessionId: "platform:blooio:+15551234568",
        message: "My name is Ada",
        platform: "blooio",
        platformUserId: "+15551234568",
        platformDisplayName: "Ada",
        platformReplyAddress: "+18087881821",
      }),
    );
    const continuation = continuationFromReply(gatewayData.reply);

    getCurrentUser.mockResolvedValue(activeStewardUser());
    const preview = await get(continuation, STEWARD_JWT);

    expect(preview.status).toBe(200);
    expect(await dataOf(preview)).toEqual({
      platform: "blooio",
      platformUserId: "+15551234568",
      platformDisplayName: "Ada",
      returnUrl: "sms:+18087881821",
    });
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

  describe("statusOnly poll — #18078 route-level contract", () => {
    /**
     * Exercises the Hono chatSchema parse + route forwarding of the statusOnly
     * flag. The route parses the request body, extracts statusOnly from the
     * schema, and forwards it to runOnboardingChat. Repeated status-only
     * requests for one session must leave the transcript unchanged — no
     * poll-generated duplicate assistant entries.
     */
    test("repeated status-only polls leave the returned transcript unchanged", async () => {
      spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
        userId: "user-9",
        organizationId: "org-9",
      });

      // First turn: a real user message so the session has content.
      const first = await post(
        { message: "My name is Alice", platform: "web" },
        "Bearer browser-session",
      );
      expect(first.status).toBe(200);
      const firstData = await dataOf(first.clone());
      const firstMessages =
        (firstData.messages as Array<{ role: string; content: string }>) ?? [];

      // Repeated status-only polls through the Hono route.
      for (let i = 0; i < 5; i++) {
        const poll = await post(
          {
            sessionId: firstData.sessionId as string,
            statusOnly: true,
            platform: "web",
          },
          "Bearer browser-session",
        );
        expect(poll.status).toBe(200);
        const pollData = await dataOf(poll.clone());
        const pollMessages =
          (pollData.messages as Array<{ role: string; content: string }>) ?? [];

        // Each poll must return the same number of messages — no growth.
        expect(pollMessages.length).toBe(firstMessages.length);
      }

      // After 5 status-only polls, the final transcript must still match the
      // initial state exactly.
      const final = await post(
        {
          sessionId: firstData.sessionId as string,
          statusOnly: true,
          platform: "web",
        },
        "Bearer browser-session",
      );
      const finalData = await dataOf(final.clone());
      const finalMessages =
        (finalData.messages as Array<{ role: string; content: string }>) ?? [];

      expect(finalMessages.length).toBe(firstMessages.length);

      // The transcript must contain exactly the expected content, proving no
      // duplicate "Eliza onboarding:" assistant entries were appended.
      const assistantContents = finalMessages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content);
      const firstAssistantContents = firstMessages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content);
      expect(assistantContents).toEqual(firstAssistantContents);
    });

    test("statusOnly flag is parsed by chatSchema and forwarded to runOnboardingChat", async () => {
      spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
        userId: "user-9",
        organizationId: "org-9",
      });

      // Start a real session first.
      const first = await post(
        { message: "My name is Bob", platform: "web" },
        "Bearer browser-session",
      );
      expect(first.status).toBe(200);
      const firstData = await dataOf(first.clone());

      // Send a status-only poll with a message attached — the route must
      // parse statusOnly from the body and forward it so the service skips
      // message processing entirely.
      const poll = await post(
        {
          sessionId: firstData.sessionId as string,
          statusOnly: true,
          message: "This should be ignored",
          platform: "web",
        },
        "Bearer browser-session",
      );
      expect(poll.status).toBe(200);
      const pollData = await dataOf(poll.clone());
      const pollMessages =
        (pollData.messages as Array<{ role: string; content: string }>) ?? [];

      // The message "This should be ignored" must NOT appear as a user turn.
      const userContents = pollMessages
        .filter((m) => m.role === "user")
        .map((m) => m.content);
      expect(userContents).not.toContain("This should be ignored");
    });
  });

  const STEWARD_JWT = "Bearer aGVhZGVy.cGF5bG9hZA.c2ln";
  const activeStewardUser = () => ({
    id: "steward-user-1",
    organization_id: "steward-org-1",
    is_active: true,
    organization: {
      id: "steward-org-1",
      name: "Steward Org",
      is_active: true,
    },
  });

  test("accepts a Steward bearer session as an authenticated (untrusted-platform) caller", async () => {
    getCurrentUser.mockResolvedValue(activeStewardUser());

    const data = await dataOf(
      await post({ message: "My name is Ada", platform: "web" }, STEWARD_JWT),
    );

    // Authenticated with a name reads the Steward account's existing status;
    // onboarding itself never creates or restarts Dedicated compute.
    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("steward-org-1");
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    // Full browser payload — a steward caller is a browser, not a gateway.
    expect(data).toHaveProperty("loginUrl");
    expect(data).toHaveProperty("messages");
  });

  test("previews the gateway-attested Discord identity and requires explicit confirmation", async () => {
    resolveIdentity.mockResolvedValue(null);
    await dataOf(
      await post({
        sessionId: "platform:discord:1234567890",
        message: "My name is Ada",
        platform: "discord",
        platformUserId: "1234567890",
        platformDisplayName: "attested-discord-user",
      }),
    );
    const storedSession = sessionCache.get(
      "eliza-app:onboarding:platform:discord:1234567890",
    ) as { continuationToken?: string };
    const continuation = storedSession.continuationToken;
    expect(continuation).toBeTruthy();
    getCurrentUser.mockResolvedValue(activeStewardUser());

    const preview = await get(continuation as string, STEWARD_JWT);
    expect(preview.status).toBe(200);
    expect(await dataOf(preview)).toEqual({
      platform: "discord",
      platformUserId: "1234567890",
      platformDisplayName: "attested-discord-user",
      returnUrl: null,
    });
    expect(linkDiscordToUser).not.toHaveBeenCalled();
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();

    const unconfirmed = await post(
      { sessionId: continuation as string, platform: "web" },
      STEWARD_JWT,
    );
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      success: false,
      code: "session_not_ready",
    });
    expect(linkDiscordToUser).not.toHaveBeenCalled();
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("previews a Telegram account-claim continuation for the authenticated browser landing", async () => {
    // Mirror the /connect DM mint: a trusted gateway turn, bound to the
    // account that owns the attested Telegram identity, statusOnly so nothing
    // is appended or provisioned.
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });
    await dataOf(
      await post({
        sessionId: `platform:telegram-claim:${"a".repeat(64)}`,
        platform: "telegram",
        platformUserId: "9911",
        platformDisplayName: "Ada",
        statusOnly: true,
      }),
    );
    const stored = sessionCache.get(
      `eliza-app:onboarding:platform:telegram-claim:${"a".repeat(64)}`,
    ) as { continuationToken?: string };
    const continuation = stored?.continuationToken;
    if (!continuation) throw new Error("Expected a claim continuation token");

    // The claim session is bound to user-9/org-9, so the generic account-bound
    // preview rejects the steward caller — the claim preview fallback answers
    // with only the Telegram identity the landing asks the user to confirm.
    getCurrentUser.mockResolvedValue(activeStewardUser());
    const preview = await get(continuation, STEWARD_JWT);
    expect(preview.status).toBe(200);
    expect(await dataOf(preview)).toEqual({
      platform: "telegram",
      platformUserId: "9911",
      platformDisplayName: "Ada",
      returnUrl: null,
    });
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();

    // An unknown continuation still fails closed on both inspection paths.
    const invalid = await get("unknown-opaque-continuation", STEWARD_JWT);
    expect(invalid.status).toBe(403);
    expect(await invalid.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
  });

  test("does not treat an account-bound ordinary Telegram session as claim authority", async () => {
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });
    await dataOf(
      await post({
        sessionId: "platform:telegram:9911",
        platform: "telegram",
        platformUserId: "9911",
        platformDisplayName: "Ada",
        statusOnly: true,
      }),
    );
    const stored = sessionCache.get(
      "eliza-app:onboarding:platform:telegram:9911",
    ) as { continuationToken?: string };
    const continuation = stored?.continuationToken;
    if (!continuation)
      throw new Error("Expected an onboarding continuation token");

    getCurrentUser.mockResolvedValue(activeStewardUser());
    const preview = await get(continuation, STEWARD_JWT);
    expect(preview.status).toBe(403);
    expect(await preview.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("a Steward caller can never mint a platform-scoped session or act as a trusted transport", async () => {
    getCurrentUser.mockResolvedValue(activeStewardUser());

    const data = await dataOf(
      await post(
        {
          sessionId: "platform:discord:1234567890",
          message: "My name is Eve",
          platform: "discord",
          platformUserId: "1234567890",
        },
        STEWARD_JWT,
      ),
    );

    // The forged platform session id is regenerated, and the attested-identity
    // account resolution path (gateway-only) never runs.
    expect(data.sessionId).not.toBe("platform:discord:1234567890");
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  test("rejects an inactive Steward user before linking or provisioning", async () => {
    getCurrentUser.mockResolvedValue({
      ...activeStewardUser(),
      is_active: false,
    });

    const response = await post(
      { message: "My name is Ada", platform: "web" },
      STEWARD_JWT,
    );

    expect(response.status).toBe(403);
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("rejects an inactive Steward organization before linking or provisioning", async () => {
    getCurrentUser.mockResolvedValue({
      ...activeStewardUser(),
      organization: {
        ...activeStewardUser().organization,
        is_active: false,
      },
    });

    const response = await post(
      { message: "My name is Ada", platform: "web" },
      STEWARD_JWT,
    );

    expect(response.status).toBe(403);
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("treats an orgless Steward session as unauthenticated instead of erroring", async () => {
    getCurrentUser.mockResolvedValue({
      id: "steward-user-2",
      organization_id: null,
      is_active: true,
      organization: null,
    });

    const data = await dataOf(
      await post({ message: "My name is Ada", platform: "web" }, STEWARD_JWT),
    );

    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(data.requiresLogin).toBe(true);
  });

  test("never consults Steward auth for a non-JWT bearer (cookie fallback stays out)", async () => {
    resolveIdentity.mockResolvedValue({ user: userRow(), identity: undefined });

    await post(
      {
        sessionId: "platform:telegram:9911",
        message: "Hello",
        platform: "telegram",
        platformUserId: "9911",
      },
      `Bearer ${INTERNAL_SECRET}`,
    );

    expect(getCurrentUser).not.toHaveBeenCalled();
  });
});

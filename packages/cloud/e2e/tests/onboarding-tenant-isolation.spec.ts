/** Proves onboarding transcript isolation through the real local cloud Worker. */
import { randomUUID } from "node:crypto";
import { seedTestUser } from "../src/fixtures/seed";
import { expect, test } from "../src/helpers/test-fixtures";

process.env.ELIZA_APP_JWT_SECRET ??= "cloud-e2e-onboarding-session-secret";

test.use({ stackOptions: { frontend: false } });
test.setTimeout(300_000);

interface OnboardingResponse {
  success: boolean;
  data: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };
}

async function createSessionToken(userId: string, organizationId: string) {
  const { elizaAppSessionService } = await import(
    "@elizaos/cloud-shared/lib/services/eliza-app/session-service"
  );
  return (await elizaAppSessionService.createSession(userId, organizationId))
    .token;
}

async function sendTurn(
  apiUrl: string,
  token: string,
  sessionId: string,
  message: string,
): Promise<{ status: number; body: OnboardingResponse }> {
  const response = await fetch(`${apiUrl}/api/eliza-app/onboarding/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId, message }),
  });
  return {
    status: response.status,
    body: (await response.json()) as OnboardingResponse,
  };
}

test.describe("onboarding tenant isolation", () => {
  test("keeps a durable transcript scoped to the authenticated account", async ({
    stack,
    seededUser: owner,
  }, testInfo) => {
    const other = await seedTestUser({
      slug: `onboarding-other-${randomUUID().slice(0, 8)}`,
    });
    const [ownerToken, otherToken] = await Promise.all([
      createSessionToken(owner.userId, owner.organizationId),
      createSessionToken(other.userId, other.organizationId),
    ]);
    const sessionId = `onboarding-${randomUUID()}`;

    const admitted = await sendTurn(
      stack.urls.api,
      ownerToken,
      sessionId,
      "owner-private-message",
    );
    expect(admitted.status).toBe(200);
    expect(admitted.body.success).toBe(true);

    const denied = await sendTurn(
      stack.urls.api,
      otherToken,
      sessionId,
      "other-account-message",
    );
    expect(denied.status).toBe(200);
    expect(denied.body.success).toBe(true);
    expect(
      denied.body.data.messages.map((message) => message.content),
    ).not.toContain("owner-private-message");

    const durableState = await sendTurn(
      stack.urls.api,
      ownerToken,
      sessionId,
      "owner-resumes-session",
    );
    expect(durableState.status).toBe(200);
    expect(durableState.body.success).toBe(true);
    expect(
      durableState.body.data.messages.map((message) => message.content),
    ).toEqual(
      expect.arrayContaining([
        "owner-private-message",
        "owner-resumes-session",
      ]),
    );
    expect(
      durableState.body.data.messages.map((message) => message.content),
    ).not.toContain("other-account-message");

    await testInfo.attach("onboarding-tenant-isolation-trace", {
      body: JSON.stringify({ admitted, denied, durableState }, null, 2),
      contentType: "application/json",
    });
  });
});

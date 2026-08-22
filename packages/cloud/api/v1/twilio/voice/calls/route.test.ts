/** Tests the outbound Twilio call boundary with provider and storage doubles. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUser = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
}));
const findUser = mock(async () => ({
  phone_number: "+14155550100",
  phone_verified: true,
}));
const resolveTarget = mock(async () => ({ agentId: "agent-1" }));
const queueCall = mock(
  async (
    _accountSid: string,
    _authToken: string,
    _method: string,
    _endpoint: string,
    _form?: URLSearchParams,
  ) => ({ sid: "CA11111111111111111111111111111111", status: "queued" }),
);
const deleteWhere = mock(async () => undefined);
const returning = mock(async () => [{ key: "claimed" }]);
const selectLimit = mock(async () => [] as Record<string, unknown>[]);
const updateWhere = mock(async () => undefined);
const outboundInserts: Record<string, unknown>[] = [];

const dbWrite = {
  insert: mock(() => ({
    values: (values: Record<string, unknown>) => {
      if ("key" in values) {
        return {
          onConflictDoNothing: () => ({ returning }),
        };
      }
      outboundInserts.push(values);
      return Promise.resolve();
    },
  })),
  delete: mock(() => ({ where: deleteWhere })),
  select: mock(() => ({
    from: () => ({
      where: () => ({ limit: selectLimit }),
    }),
  })),
  update: mock(() => ({ set: () => ({ where: updateWhere }) })),
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: requireUser,
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findById: findUser },
}));
mock.module("@/db/helpers", () => ({ dbWrite }));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: { windowMs: 300_000, maxRequests: 5 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/utils/twilio-api", () => ({
  twilioApiRequest: queueCall,
}));
mock.module("../lib/resolve-voice-target", () => ({
  resolveTwilioVoiceTarget: resolveTarget,
}));

const { default: app } = await import("./route");

const env = {
  ELIZA_APP_TWILIO_ACCOUNT_SID: "AC123",
  ELIZA_APP_TWILIO_AUTH_TOKEN: "secret",
  ELIZA_APP_TWILIO_PHONE_NUMBER: "+14484080429",
  TWILIO_PUBLIC_URL: "https://api.eliza.app",
};

function callRequest(
  body: Record<string, unknown>,
  idempotencyKey = crypto.randomUUID(),
) {
  return app.request(
    "https://api.eliza.app/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe("POST Twilio outbound voice call", () => {
  beforeEach(() => {
    requireUser.mockClear();
    findUser.mockClear();
    findUser.mockImplementation(async () => ({
      phone_number: "+14155550100",
      phone_verified: true,
    }));
    resolveTarget.mockClear();
    queueCall.mockClear();
    returning.mockClear();
    returning.mockImplementation(async () => [{ key: "claimed" }]);
    deleteWhere.mockClear();
    selectLimit.mockClear();
    selectLimit.mockImplementation(async () => []);
    updateWhere.mockClear();
    outboundInserts.length = 0;
  });

  test("queues the verified number through the signed realtime callback", async () => {
    const response = await callRequest({ to: "+14155550100" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      callId: expect.any(String),
      callSid: "CA11111111111111111111111111111111",
      status: "queued",
      to: "***0100",
    });
    expect(queueCall).toHaveBeenCalledTimes(1);
    const [, , method, endpoint, form] = queueCall.mock.calls[0] ?? [];
    expect(method).toBe("POST");
    expect(endpoint).toBe("/Calls.json");
    expect(form).toBeInstanceOf(URLSearchParams);
    expect((form as URLSearchParams).get("To")).toBe("+14155550100");
    expect((form as URLSearchParams).get("From")).toBe("+14484080429");
    expect((form as URLSearchParams).get("Url")).toBe(
      "https://api.eliza.app/api/v1/twilio/voice/inbound",
    );
    const statusCallback = new URL(
      (form as URLSearchParams).get("StatusCallback") ?? "",
    );
    expect(statusCallback.origin + statusCallback.pathname).toBe(
      "https://api.eliza.app/api/v1/twilio/voice/status",
    );
    expect(statusCallback.searchParams.get("requestId")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect((form as URLSearchParams).getAll("StatusCallbackEvent")).toEqual([
      "initiated",
      "ringing",
      "answered",
      "completed",
    ]);
    expect(outboundInserts).toHaveLength(1);
    expect(outboundInserts[0]).toMatchObject({
      user_id: "11111111-1111-4111-8111-111111111111",
      organization_id: "22222222-2222-4222-8222-222222222222",
      from_number: "+14484080429",
      to_number: "+14155550100",
      call_status: "requesting",
    });
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  test("refuses a destination other than the verified account number", async () => {
    const response = await callRequest({ to: "+14155550199" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "phone_not_verified",
    });
    expect(queueCall).not.toHaveBeenCalled();
  });

  test("requires a verified account phone number", async () => {
    findUser.mockImplementationOnce(async () => ({
      phone_number: "+14155550100",
      phone_verified: false,
    }));
    const response = await callRequest({});

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "phone_verification_required",
    });
    expect(queueCall).not.toHaveBeenCalled();
  });

  test("reclaims an expired idempotency key and queues the current call", async () => {
    returning
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ key: "reclaimed" }]);

    const response = await callRequest(
      { to: "+14155550100" },
      "00000000-0000-4000-8000-000000000001",
    );

    expect(response.status).toBe(200);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(2);
    expect(queueCall).toHaveBeenCalledTimes(1);
  });

  test("keeps a live duplicate claim fail-closed", async () => {
    returning.mockResolvedValue([]);

    const response = await callRequest(
      { to: "+14155550100" },
      "00000000-0000-4000-8000-000000000002",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "duplicate_call",
    });
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(2);
    expect(queueCall).not.toHaveBeenCalled();
  });

  test("returns the persisted call for an exact idempotent replay", async () => {
    returning.mockResolvedValue([]);
    selectLimit.mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        callSid: "CA22222222222222222222222222222222",
        status: "ringing",
        to: "+14155550100",
      },
    ]);

    const response = await callRequest(
      { to: "+14155550100" },
      "00000000-0000-4000-8000-000000000003",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      callId: "33333333-3333-4333-8333-333333333333",
      callSid: "CA22222222222222222222222222222222",
      status: "ringing",
      to: "***0100",
      replayed: true,
    });
    expect(queueCall).not.toHaveBeenCalled();
  });

  test("persists a fail-closed terminal provider error", async () => {
    queueCall.mockRejectedValueOnce(new Error("Twilio unavailable"));

    const response = await callRequest({ to: "+14155550100" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_unavailable",
    });
    expect(outboundInserts).toHaveLength(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });
});

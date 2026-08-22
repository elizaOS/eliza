/** Tests authenticated ownership, status, hangup, and replay boundaries. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const callSid = "CA11111111111111111111111111111111";
const requireUser = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
}));
interface OwnedCall {
  id: string;
  call_sid: string;
  account_sid: string;
  user_id: string;
  organization_id: string;
  to_number: string;
  call_status: string;
  answered_at: Date | null;
  terminal_at: Date | null;
  hangup_requested_at: Date | null;
}

const baseCall: OwnedCall = {
  id: "33333333-3333-4333-8333-333333333333",
  call_sid: callSid,
  account_sid: "AC123",
  user_id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  to_number: "+14155550100",
  call_status: "in-progress",
  answered_at: new Date("2026-08-22T08:00:00.000Z"),
  terminal_at: null,
  hangup_requested_at: null,
};
const selectLimit = mock(async (): Promise<OwnedCall[]> => [baseCall]);
const returning = mock(async () => [{ key: "claimed" }]);
const updateWhere = mock(async () => undefined);
const deleteWhere = mock(async () => undefined);
const providerRequest = mock(
  async (
    _accountSid: string,
    _authToken: string,
    _method: string,
    _endpoint: string,
    _form?: URLSearchParams,
  ) => ({ status: "completed" }),
);
const dbWrite = {
  select: mock(() => ({
    from: () => ({ where: () => ({ limit: selectLimit }) }),
  })),
  insert: mock(() => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning }),
    }),
  })),
  update: mock(() => ({ set: () => ({ where: updateWhere }) })),
  delete: mock(() => ({ where: deleteWhere })),
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: requireUser,
}));
mock.module("@/db/helpers", () => ({ dbWrite }));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: { windowMs: 300_000, maxRequests: 5 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/utils/twilio-api", () => ({
  twilioApiRequest: providerRequest,
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:callSid", route);
const env = {
  ELIZA_APP_TWILIO_ACCOUNT_SID: "AC123",
  ELIZA_APP_TWILIO_AUTH_TOKEN: "secret",
};

function request(method: "GET" | "DELETE", idempotencyKey?: string) {
  return app.request(
    `/${callSid}`,
    {
      method,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    },
    env as never,
  );
}

describe("Twilio outbound owned call", () => {
  beforeEach(() => {
    selectLimit.mockClear();
    selectLimit.mockImplementation(async () => [baseCall]);
    returning.mockClear();
    returning.mockImplementation(async () => [{ key: "claimed" }]);
    updateWhere.mockClear();
    deleteWhere.mockClear();
    providerRequest.mockClear();
    providerRequest.mockImplementation(
      async (
        _accountSid: string,
        _authToken: string,
        _method: string,
        _endpoint: string,
        _form?: URLSearchParams,
      ) => ({ status: "completed" }),
    );
  });

  test("returns only the authenticated user's persisted call status", async () => {
    const response = await request("GET");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      callSid,
      status: "in-progress",
      to: "***0100",
      answeredAt: "2026-08-22T08:00:00.000Z",
      terminalAt: null,
      hangupRequestedAt: null,
    });
  });

  test("requests one provider hangup and persists it", async () => {
    const response = await request(
      "DELETE",
      "44444444-4444-4444-8444-444444444444",
    );

    expect(response.status).toBe(200);
    expect(providerRequest).toHaveBeenCalledTimes(1);
    expect(providerRequest.mock.calls[0]?.slice(2)).toEqual([
      "POST",
      `/Calls/${callSid}.json`,
      new URLSearchParams({ Status: "completed" }),
    ]);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  test("replays the hangup claim without a second provider request", async () => {
    returning.mockResolvedValueOnce([]);

    const response = await request(
      "DELETE",
      "55555555-5555-4555-8555-555555555555",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ replayed: true });
    expect(providerRequest).not.toHaveBeenCalled();
  });

  test("hides missing or unauthorized calls", async () => {
    selectLimit.mockResolvedValueOnce([]);

    const response = await request("GET");

    expect(response.status).toBe(404);
  });

  test("does not call the provider when the call is already terminal", async () => {
    selectLimit.mockResolvedValueOnce([
      {
        ...baseCall,
        call_status: "completed",
        terminal_at: new Date("2026-08-22T08:01:00.000Z"),
      },
    ]);

    const response = await request("DELETE");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      alreadyTerminal: true,
      status: "completed",
    });
    expect(providerRequest).not.toHaveBeenCalled();
  });

  test("fails closed and remains auditable when Twilio is unavailable", async () => {
    providerRequest.mockRejectedValueOnce(new Error("unavailable"));

    const response = await request(
      "DELETE",
      "66666666-6666-4666-8666-666666666666",
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_unavailable",
    });
    expect(updateWhere).not.toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});

/** Tests signed outbound-call status receipt validation and durable writes. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requestId = "33333333-3333-4333-8333-333333333333";
const callSid = "CA11111111111111111111111111111111";
const selectLimit = mock(async () => [
  {
    id: requestId,
    callSid,
    accountSid: "AC123",
    from: "+14484080429",
    to: "+14155550100",
  },
]);
const verifySignature = mock(
  async (
    _authToken: string,
    _signature: string,
    _url: string,
    _params: Record<string, string>,
  ) => true,
);
const insertConflict = mock(async () => undefined);
const updateWhere = mock(async () => undefined);
const updateSets: Record<string, unknown>[] = [];
const tx = {
  insert: mock(() => ({
    values: () => ({ onConflictDoNothing: insertConflict }),
  })),
  update: mock(() => ({
    set: (values: Record<string, unknown>) => {
      updateSets.push(values);
      return { where: updateWhere };
    },
  })),
};
const writeTransaction = mock(async (callback: (value: typeof tx) => unknown) =>
  callback(tx),
);
const dbWrite = {
  select: mock(() => ({
    from: () => ({ where: () => ({ limit: selectLimit }) }),
  })),
};

mock.module("@/db/helpers", () => ({ dbWrite, writeTransaction }));
mock.module("@/lib/utils/twilio-api", () => ({
  verifyTwilioSignature: verifySignature,
}));

const { default: app } = await import("./route");

const env = {
  ELIZA_APP_TWILIO_AUTH_TOKEN: "secret",
  TWILIO_PUBLIC_URL: "https://api.eliza.app",
};

function statusRequest(
  overrides: Record<string, string> = {},
  signature = "valid",
) {
  const body = new URLSearchParams({
    CallSid: callSid,
    AccountSid: "AC123",
    CallStatus: "completed",
    SequenceNumber: "3",
    From: "+14484080429",
    To: "+14155550100",
    Timestamp: "2026-08-22T08:00:00.000Z",
    ...overrides,
  });
  return app.request(
    `https://worker.internal/?requestId=${requestId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body,
    },
    env as never,
  );
}

describe("POST Twilio outbound status callback", () => {
  beforeEach(() => {
    selectLimit.mockClear();
    selectLimit.mockImplementation(async () => [
      {
        id: requestId,
        callSid,
        accountSid: "AC123",
        from: "+14484080429",
        to: "+14155550100",
      },
    ]);
    verifySignature.mockClear();
    verifySignature.mockImplementation(
      async (
        _authToken: string,
        _signature: string,
        _url: string,
        _params: Record<string, string>,
      ) => true,
    );
    insertConflict.mockClear();
    updateWhere.mockClear();
    updateSets.length = 0;
    writeTransaction.mockClear();
  });

  test("verifies the exact public URL and persists a terminal receipt", async () => {
    const response = await statusRequest();

    expect(response.status).toBe(204);
    expect(verifySignature).toHaveBeenCalledTimes(1);
    expect(verifySignature.mock.calls[0]?.[2]).toBe(
      `https://api.eliza.app/api/v1/twilio/voice/status?requestId=${requestId}`,
    );
    expect(writeTransaction).toHaveBeenCalledTimes(1);
    expect(insertConflict).toHaveBeenCalledTimes(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(updateSets[0]).toMatchObject({
      call_sid: callSid,
      call_status: "completed",
      last_status_sequence: 3,
      provider_error_code: null,
      terminal_at: new Date("2026-08-22T08:00:00.000Z"),
    });
  });

  test("rejects an invalid signature before loading or writing a call", async () => {
    verifySignature.mockResolvedValueOnce(false);

    const response = await statusRequest({}, "invalid");

    expect(response.status).toBe(403);
    expect(selectLimit).not.toHaveBeenCalled();
    expect(writeTransaction).not.toHaveBeenCalled();
  });

  test("rejects a mismatched provider call identity", async () => {
    const response = await statusRequest({ To: "+14155550199" });

    expect(response.status).toBe(403);
    expect(writeTransaction).not.toHaveBeenCalled();
  });

  test("rejects unknown statuses and unsafe sequence numbers", async () => {
    const unknown = await statusRequest({ CallStatus: "invented" });
    const unsafe = await statusRequest({ SequenceNumber: "9007199254740992" });

    expect(unknown.status).toBe(400);
    expect(unsafe.status).toBe(400);
    expect(writeTransaction).not.toHaveBeenCalled();
  });

  test("accepts duplicate signed receipts through conflict-safe persistence", async () => {
    const first = await statusRequest({
      CallStatus: "ringing",
      SequenceNumber: "1",
    });
    const duplicate = await statusRequest({
      CallStatus: "ringing",
      SequenceNumber: "1",
    });

    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(writeTransaction).toHaveBeenCalledTimes(2);
    expect(insertConflict).toHaveBeenCalledTimes(2);
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]).toMatchObject({
      call_status: "ringing",
      last_status_sequence: 1,
      terminal_at: null,
    });
  });
});

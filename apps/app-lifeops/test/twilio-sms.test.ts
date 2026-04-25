import { afterEach, describe, expect, test, vi } from "vitest";
import { sendTwilioSms } from "../src/lifeops/twilio.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("sendTwilioSms", () => {
  test("returns structured billing for outbound SMS", async () => {
    process.env.TWILIO_SMS_COST_PER_SEGMENT_USD = "0.0075";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sid: "SM123",
          status: "queued",
          to: "+15551234567",
          from: "+15550000000",
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await sendTwilioSms({
      credentials: {
        accountSid: "AC123",
        authToken: "token",
        fromPhoneNumber: "+15550000000",
      },
      to: "+15551234567",
      body: "x".repeat(481),
    });

    expect(result.ok).toBe(true);
    expect(result.billing).toEqual({
      rawCost: 0.03,
      markup: 0.01,
      billedCost: 0.04,
      markupRate: 0.2,
      segments: 4,
      costPerSegment: 0.0075,
    });
  });
});

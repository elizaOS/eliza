/** Exercises typed Twilio REST outcomes with a deterministic fetch boundary. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { twilioApiRequest } from "./twilio-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("twilioApiRequest typed outcomes", () => {
  test.each([
    [400, "TWILIO_PROVIDER_REJECTED"],
    [429, "TWILIO_PROVIDER_REJECTED"],
    [500, "TWILIO_SUBMISSION_UNCERTAIN"],
  ])("classifies provider status %d as %s", async (status, code) => {
    const fetchMock = mock(async () => new Response("provider body", { status }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const error = await twilioApiRequest(
      "AC123",
      "secret",
      "POST",
      "/Calls.json",
      new URLSearchParams({ To: "+14155550100" }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ElizaError);
    expect(error).toMatchObject({
      code,
      context: {
        providerStatus: status,
        retryable: status === 429,
      },
    });
    expect(String((error as Error).message)).not.toContain("provider body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["", "empty"],
    ["not-json", "invalid JSON"],
  ])("rejects an accepted %s receipt", async (body) => {
    globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as never;

    await expect(twilioApiRequest("AC123", "secret", "POST", "/Calls.json")).rejects.toMatchObject({
      code: "TWILIO_RECEIPT_INVALID",
    });
  });

  test("preserves transport ambiguity and cause after dispatch", async () => {
    const transportError = new Error("connection reset after write");
    globalThis.fetch = mock(async () => {
      throw transportError;
    }) as never;

    await expect(twilioApiRequest("AC123", "secret", "POST", "/Calls.json")).rejects.toMatchObject({
      code: "TWILIO_SUBMISSION_UNCERTAIN",
      cause: transportError,
    });
  });
});

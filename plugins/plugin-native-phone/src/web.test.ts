import { describe, expect, it } from "vitest";

import { PhoneWeb } from "./web";

describe("PhoneWeb fallback", () => {
  it("returns disabled phone status on non-Android runtimes", async () => {
    await expect(new PhoneWeb().getStatus()).resolves.toEqual({
      hasTelecom: false,
      canPlaceCalls: false,
      isDefaultDialer: false,
      defaultDialerPackage: null,
    });
  });

  it("rejects malformed call targets before Android-only fallback errors", async () => {
    const phone = new PhoneWeb();

    await expect(
      phone.placeCall(undefined as unknown as { number: string }),
    ).rejects.toThrow("number is required");
    await expect(phone.placeCall({ number: "" })).rejects.toThrow(
      "number is required",
    );
    await expect(
      phone.placeCall({ number: ["+15550100"] as unknown as string }),
    ).rejects.toThrow("number is required");
    await expect(phone.openDialer({ number: "\n\t" })).rejects.toThrow(
      "number is required",
    );
    await expect(phone.placeCall({ number: "+15550100" })).rejects.toThrow(
      "Phone calls are only available on Android.",
    );
    await expect(phone.openDialer()).rejects.toThrow(
      "Phone dialer is only available on Android.",
    );
  });

  it.each([
    0,
    -1,
    501,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects malformed recent-call limit %s", async (limit) => {
    const phone = new PhoneWeb();

    await expect(phone.listRecentCalls({ limit })).rejects.toThrow(
      "limit must be between 1 and 500",
    );
  });

  it("rejects non-object recent-call options without poisoning later calls", async () => {
    const phone = new PhoneWeb();

    await expect(
      phone.listRecentCalls("limit=1" as unknown as { limit: number }),
    ).rejects.toThrow("options must be an object");
    await expect(phone.listRecentCalls({ limit: 1 })).resolves.toEqual({
      calls: [],
    });
  });

  it("rejects malformed recent-call filters and transcript payloads", async () => {
    const phone = new PhoneWeb();

    await expect(phone.listRecentCalls({ number: " " })).rejects.toThrow(
      "number must be a non-empty string",
    );
    await expect(
      phone.saveCallTranscript({ callId: "", transcript: "hello" }),
    ).rejects.toThrow("callId is required");
    await expect(
      phone.saveCallTranscript({ callId: "call-1", transcript: "\n\t" }),
    ).rejects.toThrow("transcript is required");
    await expect(
      phone.saveCallTranscript(
        null as unknown as { callId: string; transcript: string },
      ),
    ).rejects.toThrow("callId is required");
    await expect(
      phone.saveCallTranscript({ callId: "call-1", transcript: "hello" }),
    ).rejects.toThrow("Call transcripts are only available on Android.");
  });

  it("accepts hostile-looking user strings only after validation succeeds", async () => {
    const phone = new PhoneWeb();

    await expect(
      phone.listRecentCalls({ number: "%' OR 1=1 --", limit: 2 }),
    ).resolves.toEqual({ calls: [] });
    await expect(
      phone.saveCallTranscript({
        callId: "__proto__",
        transcript: "<script>alert(1)</script>",
        summary: '{"polluted":true}',
      }),
    ).rejects.toThrow("Call transcripts are only available on Android.");
  });
});

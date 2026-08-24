import { describe, expect, it } from "vitest";
import { proactiveInboxDigestRequest } from "./proactive-inbox-digest.ts";

describe("proactiveInboxDigestRequest", () => {
  it("returns the personal-inbox channels", () => {
    const request = proactiveInboxDigestRequest();
    expect(request.channels).toEqual([
      "gmail",
      "x_dm",
      "imessage",
      "whatsapp",
      "sms",
    ]);
    expect(request.limit).toBe(24);
    expect(request.missedOnly).toBe(true);
  });

  it("returns a channels copy (mutating the result is safe)", () => {
    const request = proactiveInboxDigestRequest();
    request.channels!.push("slack");
    const next = proactiveInboxDigestRequest();
    expect(next.channels).not.toContain("slack");
    expect(next.channels).toHaveLength(5);
  });
});

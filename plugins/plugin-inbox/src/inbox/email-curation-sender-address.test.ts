import { describe, expect, it } from "vitest";
import { extractAsciiEmailAddress } from "./email-address.ts";
import { curateEmailCandidates } from "./email-curation.ts";

describe("sender address local part", () => {
  it("keeps apostrophes and other RFC 5322 local-part characters", () => {
    expect(
      extractAsciiEmailAddress("Pat O'Brien <pat.o'brien@example.com>"),
    ).toBe("pat.o'brien@example.com");
    expect(extractAsciiEmailAddress("Ops <ops&dev@example.org>")).toBe(
      "ops&dev@example.org",
    );
    expect(extractAsciiEmailAddress("x=y@example.com")).toBe("x=y@example.com");
    expect(extractAsciiEmailAddress("'bob@example.com'")).toBe(
      "bob@example.com",
    );
    expect(extractAsciiEmailAddress("Hans <müller@example.de>")).toBeNull();
  });

  it("does not match a different sender to a VIP by the suffix after an apostrophe", () => {
    const out = curateEmailCandidates({
      now: "2026-10-10T12:00:00Z",
      identityContext: {
        vipContacts: [
          {
            id: "boss",
            name: "Pat O'Brien (CEO)",
            emails: ["pat.o'brien@example.com"],
          },
        ],
      },
      candidates: [
        {
          id: "m1",
          subject: "50% off this weekend only",
          from: "Deals <brien@example.com>",
          snippet: "Unsubscribe any time",
          labels: ["CATEGORY_PROMOTIONS"],
          receivedAt: "2026-10-09T12:00:00Z",
        },
      ],
    });
    expect(out.decisions[0]?.identity.kind).toBe("unknown");
    expect(out.decisions[0]?.blockedActions).toEqual([]);
  });
});

/**
 * Unit tests for the pure domain-intent helpers: domain extraction from
 * planner options / prose, validation, USD formatting, duck-typed
 * CloudApiError inspection, and the domain-line formatter.
 */

import { describe, expect, it } from "bun:test";
import type { Memory } from "@elizaos/core";
import {
  actionParams,
  cloudErrorInfo,
  extractDomainReferences,
  formatDomainLine,
  isValidDomain,
  usdFromCents,
} from "../src/domain-intent.ts";

function msg(text: string): Memory {
  return { content: { text } } as unknown as Memory;
}

describe("isValidDomain", () => {
  it("accepts registrable domains", () => {
    expect(isValidDomain("example.com")).toBe(true);
    expect(isValidDomain("sub.example.co.uk")).toBe(true);
    expect(isValidDomain("my-brand.io")).toBe(true);
  });

  it("rejects non-domains", () => {
    expect(isValidDomain("example")).toBe(false);
    expect(isValidDomain("-bad.com")).toBe(false);
    expect(isValidDomain("bad-.com")).toBe(false);
    expect(isValidDomain("a.b")).toBe(false); // TLD must be 2+ alpha
    expect(isValidDomain("exa mple.com")).toBe(false);
    expect(isValidDomain(`${"a".repeat(260)}.com`)).toBe(false);
  });
});

describe("extractDomainReferences", () => {
  it("prefers a planner-supplied option over prose", () => {
    expect(
      extractDomainReferences(msg("buy coolsite.io"), {
        domain: "Chosen.com",
      }),
    ).toEqual(["chosen.com"]);
  });

  it("reads options nested under parameters (real planner path)", () => {
    expect(
      extractDomainReferences(msg("irrelevant"), {
        parameters: { domain: "nested.com" },
      }),
    ).toEqual(["nested.com"]);
  });

  it("returns empty for an invalid option instead of falling back to prose", () => {
    expect(
      extractDomainReferences(msg("buy coolsite.io"), {
        domain: "not a domain",
      }),
    ).toEqual([]);
  });

  it("collects distinct normalized domains from prose", () => {
    expect(
      extractDomainReferences(
        msg("is Example.com or coolsite.io available? maybe example.com."),
      ),
    ).toEqual(["example.com", "coolsite.io"]);
  });

  it("finds a domain inside a URL mention", () => {
    expect(
      extractDomainReferences(msg("point https://example.com at it")),
    ).toEqual(["example.com"]);
  });

  it("returns empty when the text names no domain", () => {
    expect(extractDomainReferences(msg("buy me a domain please"))).toEqual([]);
  });
});

describe("actionParams", () => {
  it("merges nested parameters over top-level keys", () => {
    expect(
      actionParams({ appName: "Top", parameters: { appName: "Nested" } }),
    ).toMatchObject({ appName: "Nested" });
  });

  it("returns empty for non-object options", () => {
    expect(actionParams(undefined)).toEqual({});
    expect(actionParams("nope")).toEqual({});
  });
});

describe("usdFromCents", () => {
  it("formats integer cents", () => {
    expect(usdFromCents(1399)).toBe("$13.99");
    expect(usdFromCents(0)).toBe("$0.00");
  });
});

describe("cloudErrorInfo", () => {
  it("reads a CloudApiError-shaped error", () => {
    const err = Object.assign(new Error("Insufficient credit balance"), {
      statusCode: 402,
      errorBody: {
        success: false,
        error: "Insufficient credit balance for this domain",
        code: "insufficient_balance",
      },
    });
    expect(cloudErrorInfo(err)).toEqual({
      status: 402,
      code: "insufficient_balance",
      message: "Insufficient credit balance for this domain",
    });
  });

  it("degrades gracefully on plain errors", () => {
    expect(cloudErrorInfo(new Error("boom"))).toEqual({
      status: null,
      code: null,
      message: "boom",
    });
  });

  it("never throws on junk", () => {
    expect(cloudErrorInfo(null).status).toBe(null);
    expect(cloudErrorInfo(undefined).status).toBe(null);
    expect(cloudErrorInfo(42).status).toBe(null);
  });
});

describe("formatDomainLine", () => {
  it("summarizes a cloudflare-registered active domain", () => {
    const line = formatDomainLine({
      domain: "example.com",
      registrar: "cloudflare",
      status: "active",
      verified: true,
      sslStatus: "active",
      expiresAt: "2027-07-01T00:00:00.000Z",
    });
    expect(line).toContain("example.com");
    expect(line).toContain("registered through Eliza Cloud");
    expect(line).toContain("SSL active");
    expect(line).toContain("renews 2027-07-01");
  });

  it("tells an unverified external domain owner the exact TXT record", () => {
    const line = formatDomainLine({
      domain: "example.org",
      registrar: "external",
      status: "pending",
      verified: false,
      sslStatus: "pending",
      expiresAt: null,
    });
    expect(line).toContain("_eliza-cloud-verify.example.org");
  });
});

describe("extractDomainReferences boundaries", () => {
  it("never mangles an IDN into a bogus ASCII tail", () => {
    expect(extractDomainReferences(msg("register münchen.de please"))).toEqual(
      [],
    );
  });

  it("does not treat an email's domain part as a purchase target", () => {
    expect(
      extractDomainReferences(msg("email me at user@example.com")),
    ).toEqual([]);
  });

  it("keeps a long TLD intact instead of splitting it", () => {
    expect(extractDomainReferences(msg("buy example.community"))).toEqual([
      "example.community",
    ]);
  });

  it("stays linear on pathological dotted input and drops over-long tokens", () => {
    const junk = `${"a.".repeat(500)}com`;
    expect(extractDomainReferences(msg(`look at ${junk}`))).toEqual([]);
  });
});

describe("formatDomainLine edge values", () => {
  it("renders a null sslStatus as pending, not 'SSL null'", () => {
    const line = formatDomainLine({
      domain: "example.com",
      registrar: "cloudflare",
      status: "pending",
      verified: false,
      sslStatus: null,
      expiresAt: null,
    });
    expect(line).toContain("SSL pending");
    expect(line).not.toContain("null");
  });

  it("includes the TXT record VALUE when the verification token is known", () => {
    const line = formatDomainLine({
      domain: "example.org",
      registrar: "external",
      status: "pending",
      verified: false,
      sslStatus: "pending",
      expiresAt: null,
      verificationToken: "eliza-verify-abc123",
    });
    expect(line).toContain("_eliza-cloud-verify.example.org");
    expect(line).toContain("eliza-verify-abc123");
  });
});

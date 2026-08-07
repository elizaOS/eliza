/** Verifies routed reply CTAs become well-formed Discord link-button components. */
import { describe, expect, test } from "bun:test";
import {
  buildManagedFailureReplyOptions,
  buildManagedReplyOptions,
  buildReplyComponents,
  MANAGED_REPLY_UNAVAILABLE_TEXT,
} from "../src/reply-components";

describe("buildReplyComponents", () => {
  test("a valid CTA becomes one action row with one style-5 link button", () => {
    const components = buildReplyComponents({
      label: "Connect",
      url: "https://app.elizacloud.ai/get-started/?onboardingSession=abc-123",
    });

    expect(components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Connect",
            url: "https://app.elizacloud.ai/get-started/?onboardingSession=abc-123",
          },
        ],
      },
    ]);
  });

  test("null/undefined CTA yields no components", () => {
    expect(buildReplyComponents(null)).toBeNull();
    expect(buildReplyComponents(undefined)).toBeNull();
  });

  test("missing or empty label/url yields no components", () => {
    expect(buildReplyComponents({ url: "https://example.com" })).toBeNull();
    expect(buildReplyComponents({ label: "Connect" })).toBeNull();
    expect(
      buildReplyComponents({ label: "  ", url: "https://example.com" }),
    ).toBeNull();
    expect(buildReplyComponents({ label: "Connect", url: "" })).toBeNull();
  });

  test("non-string CTA fields yield no components (contract drift degrades to plain text)", () => {
    expect(
      buildReplyComponents({ label: 42, url: "https://example.com" }),
    ).toBeNull();
    expect(
      buildReplyComponents({ label: "Connect", url: { href: "x" } }),
    ).toBeNull();
  });

  test("non-https URLs are rejected", () => {
    expect(
      buildReplyComponents({ label: "Connect", url: "http://example.com" }),
    ).toBeNull();
    expect(
      buildReplyComponents({ label: "Connect", url: "javascript:alert(1)" }),
    ).toBeNull();
    expect(
      buildReplyComponents({ label: "Connect", url: "not a url" }),
    ).toBeNull();
  });

  test("labels are capped at Discord's 80-character button limit", () => {
    const components = buildReplyComponents({
      label: "x".repeat(120),
      url: "https://example.com",
    });
    expect(components?.[0]?.components[0]?.label).toHaveLength(80);
  });

  test("URLs over Discord's 512-character button limit drop the button (API would reject the send)", () => {
    const overlong = `https://example.com/${"a".repeat(512)}`;
    expect(
      buildReplyComponents({ label: "Connect", url: overlong }),
    ).toBeNull();
    // At exactly the bound the button survives.
    const atBound = `https://example.com/${"a".repeat(512 - "https://example.com/".length)}`;
    expect(atBound).toHaveLength(512);
    expect(
      buildReplyComponents({ label: "Connect", url: atBound }),
    ).not.toBeNull();
  });
});

describe("managed reply options", () => {
  test("the failure notice takes a nonce distinct from the primary reply", () => {
    const primary = buildManagedReplyOptions("123456789012345678", "hello", {
      label: "Connect",
      url: "https://example.com/connect",
    });
    const fallback = buildManagedFailureReplyOptions("123456789012345678");

    expect(primary.nonce).toBe("123456789012345678");
    expect(primary.enforceNonce).toBe(true);
    expect(primary.allowedMentions).toEqual({ repliedUser: false });
    expect(primary.components).toHaveLength(1);
    expect(fallback).toEqual({
      content: MANAGED_REPLY_UNAVAILABLE_TEXT,
      nonce: "123456789012345678-f",
      enforceNonce: true,
      allowedMentions: { repliedUser: false },
    });

    // Regression: sharing the primary nonce makes the two messages
    // interchangeable to Discord's deduplicator, so a posted failure notice
    // suppresses the real reply on a gateway resume replay and strands the
    // user on the failure text permanently.
    expect(fallback.nonce).not.toBe(primary.nonce);
    // Discord caps the nonce at 25 characters; a snowflake is 19.
    expect(String(fallback.nonce).length).toBeLessThanOrEqual(25);
  });
});

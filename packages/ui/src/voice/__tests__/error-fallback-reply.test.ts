/**
 * Unit coverage for the voice self-test error-fallback reply classifier.
 * Drives the real `classifyErrorFallbackReply` against every canonical
 * server fallback string it must pin, its normalization rules, and the
 * pattern fallbacks — plus genuine replies that must stay unclassified.
 */
import { describe, expect, it } from "vitest";
import {
  classifyErrorFallbackReply,
  type ErrorFallbackReplyKind,
} from "../voice-selftest/error-fallback-reply";

const CANONICAL_CASES: ReadonlyArray<{
  text: string;
  kind: ErrorFallbackReplyKind;
}> = [
  {
    text: "sorry, i'm having a provider issue",
    kind: "provider_issue",
  },
  {
    text: "i don't have a reply for that — try rephrasing?",
    kind: "no_response",
  },
  {
    text: "i don't have a reply for that - try rephrasing?",
    kind: "no_response",
  },
  {
    text: "the configured ai provider is out of credits or quota. add credits or increase its quota, then try again.",
    kind: "insufficient_credits",
  },
  {
    text: "eliza cloud credits are depleted. top up the cloud balance and try again.",
    kind: "insufficient_credits",
  },
  {
    text: "i'm being rate-limited right now — give it a few seconds and try again.",
    kind: "rate_limited",
  },
  {
    text: "connect an llm provider to start chatting. open settings → providers, or choose eliza cloud during first-run setup.",
    kind: "no_provider",
  },
  {
    text: "something went wrong on my end. please try again.",
    kind: "transient_failure",
  },
];

describe("classifyErrorFallbackReply", () => {
  it("returns null for absent or blank replies", () => {
    expect(classifyErrorFallbackReply(null)).toBeNull();
    expect(classifyErrorFallbackReply(undefined)).toBeNull();
    expect(classifyErrorFallbackReply("")).toBeNull();
    expect(classifyErrorFallbackReply("   ")).toBeNull();
    expect(classifyErrorFallbackReply("\n\t ")).toBeNull();
  });

  it("pins every canonical server fallback string to its kind", () => {
    for (const { text, kind } of CANONICAL_CASES) {
      expect(classifyErrorFallbackReply(text)).toBe(kind);
    }
  });

  it("classifies through trimming, casing, apostrophe, and whitespace normalization", () => {
    expect(
      classifyErrorFallbackReply("  SORRY, I'M HAVING A PROVIDER ISSUE  "),
    ).toBe("provider_issue");
    expect(
      classifyErrorFallbackReply("sorry, i\u2019m having a provider issue"),
    ).toBe("provider_issue");
    expect(
      classifyErrorFallbackReply(
        "i\tdon't   have\na reply for that — try rephrasing?",
      ),
    ).toBe("no_response");
    expect(
      classifyErrorFallbackReply(
        "Something Went Wrong On My End. Please Try Again.",
      ),
    ).toBe("transient_failure");
  });

  it("falls back to provider_issue for any normalized 'provider issue' phrase", () => {
    expect(
      classifyErrorFallbackReply("we hit a provider issue while generating"),
    ).toBe("provider_issue");
    expect(classifyErrorFallbackReply("A PROVIDER ISSUE occurred")).toBe(
      "provider_issue",
    );
  });

  it("falls back to transient_failure only for the 'something went wrong on my end' prefix", () => {
    expect(
      classifyErrorFallbackReply(
        "something went wrong on my end while starting up",
      ),
    ).toBe("transient_failure");
    expect(classifyErrorFallbackReply("something went wrong today")).toBeNull();
  });

  it("requires the whole 'provider issue' phrase, not fragments", () => {
    expect(
      classifyErrorFallbackReply("your provider settings were saved"),
    ).toBeNull();
    expect(classifyErrorFallbackReply("the provider issued a warning")).toBe(
      null,
    );
  });

  it("returns null for genuine model replies", () => {
    expect(classifyErrorFallbackReply("Your wallet balance is 12.5 SOL.")).toBe(
      null,
    );
    expect(
      classifyErrorFallbackReply("I moved the task to tomorrow morning."),
    ).toBeNull();
  });
});

// Unit test for the onboarding liveness contract (#14359). Exercises the pure,
// surface-agnostic core (`assertLiveReply` / `isLiveReply`) — the rule every
// onboarding lane shares — with no DOM/Playwright harness: a stub-marker reply
// must fail, a real reply must pass, and empty/non-string replies must fail.
// The challenge-binding extension (#16936) is covered here too: the run-unique
// token must be echoed by the reply, and every fail-open shape the review
// found — pending status rows, elapsed status text, cached/unrelated replies,
// wrong-code answers — must fail.
import { describe, expect, it } from "vitest";

import { extractIosLivenessChallengeToken } from "../src/ios-cloud-onboarding-smoke";
import {
  assertLiveChallengeReply,
  assertLiveReply,
  buildLivenessChallenge,
  extractLivenessChallengeToken,
  findAnchoredLiveTurn,
  isLiveReply,
  LivenessAssertionError,
  STUB_FIXTURE_MARKER,
} from "./liveness-contract.mjs";

describe("onboarding liveness contract", () => {
  it("passes a real, non-empty reply and returns it trimmed", () => {
    expect(assertLiveReply("  Hello there!  ")).toBe("Hello there!");
    expect(isLiveReply("Hello there!")).toBe(true);
  });

  it("fails a reply carrying the stub fixture marker", () => {
    const stubbed = `{"fixture":"${STUB_FIXTURE_MARKER}","transport":"sse"}`;
    expect(() => assertLiveReply(stubbed)).toThrowError(LivenessAssertionError);
    expect(() => assertLiveReply(stubbed)).toThrow(/stub fixture marker/);
    expect(isLiveReply(stubbed)).toBe(false);
  });

  it("fails an empty or whitespace-only reply (model never answered)", () => {
    expect(() => assertLiveReply("")).toThrow(/empty/);
    expect(() => assertLiveReply("   \n\t ")).toThrow(/empty/);
    expect(isLiveReply("")).toBe(false);
  });

  it("fails a non-string reply", () => {
    expect(() => assertLiveReply(null)).toThrow(/must be a string/);
    expect(() => assertLiveReply(undefined)).toThrow(/must be a string/);
    expect(() => assertLiveReply(42)).toThrow(/must be a string/);
    expect(isLiveReply(null)).toBe(false);
  });

  it("attributes the failure to the lane label when provided", () => {
    expect(() =>
      assertLiveReply(STUB_FIXTURE_MARKER, { label: "android-onboarding" }),
    ).toThrow(/android-onboarding: /);
  });
});

describe("liveness challenge construction and extraction", () => {
  it("round-trips a fresh token through build/extract unchanged", () => {
    const prompt = buildLivenessChallenge("a1b2c3");
    expect(prompt).toBe(
      "Reply with exactly this code to confirm you are live: a1b2c3",
    );
    expect(extractLivenessChallengeToken(prompt)).toBe("a1b2c3");
  });

  it("keeps the in-app iOS token extraction in lockstep with the shared contract", () => {
    // src/ios-cloud-onboarding-smoke.ts cannot import from test/ (the bundled
    // renderer must not depend on test files), so this pins the duplicated
    // marker: if either side drifts, the iOS driver silently degrades to the
    // weaker phase-only gate and this test goes red.
    for (const token of ["a1b2c3", "DEADBeef42", "0"]) {
      const prompt = buildLivenessChallenge(token);
      expect(extractIosLivenessChallengeToken(prompt)).toBe(
        extractLivenessChallengeToken(prompt),
      );
    }
    expect(
      extractIosLivenessChallengeToken("In one short sentence, say hello."),
    ).toBe("");
  });

  it("normalizes case and surrounding whitespace, and matches the LAST marker", () => {
    expect(
      extractLivenessChallengeToken(
        "Reply with exactly this code to confirm you are live: A1B2C3  ",
      ),
    ).toBe("a1b2c3");
    expect(
      extractLivenessChallengeToken(
        `prefix Reply with exactly this code to confirm you are live: deadbee and again Reply with exactly this code to confirm you are live: f00d42`,
      ),
    ).toBe("f00d42");
  });

  it("returns an empty token for prompts without the challenge marker", () => {
    expect(
      extractLivenessChallengeToken("In one short sentence, say hello."),
    ).toBe("");
    expect(extractLivenessChallengeToken("")).toBe("");
    expect(extractLivenessChallengeToken(null)).toBe("");
  });
});

describe("liveness challenge reply assertion", () => {
  const token = "9f8e7d";

  it("passes a reply echoing the token and returns it trimmed", () => {
    expect(
      assertLiveChallengeReply(`  The code is ${token}  `, {
        challengeToken: token,
      }),
    ).toBe(`The code is ${token}`);
  });

  it("matches the token case-insensitively (models echo uppercase hex)", () => {
    expect(() =>
      assertLiveChallengeReply("9F8E7D", { challengeToken: token }),
    ).not.toThrow();
  });

  it("fails the pending status rows the review found fail-open", () => {
    // iOS pending row text content; Android transient filter gaps.
    for (const statusReply of [
      "Thinking",
      "Thinking · 1s",
      "Thinking · 4s",
      "Replying",
      "Running WEB_SEARCH · 12s",
      "Speaking",
    ]) {
      expect(() =>
        assertLiveChallengeReply(statusReply, {
          challengeToken: token,
          label: "lane",
        }),
      ).toThrow(LivenessAssertionError);
    }
  });

  it("fails an unrelated, cached, or wrong-code reply", () => {
    expect(() =>
      assertLiveChallengeReply("Hello!", { challengeToken: token }),
    ).toThrow(/did not echo this run's challenge token/);
    expect(() =>
      assertLiveChallengeReply("The code is deadbeef", {
        challengeToken: token,
      }),
    ).toThrow(/did not echo this run's challenge token/);
  });

  it("fails empty, non-string, and stub-marked replies via the shared base rules", () => {
    expect(() =>
      assertLiveChallengeReply("", { challengeToken: token }),
    ).toThrow(/empty/);
    expect(() =>
      assertLiveChallengeReply(null, { challengeToken: token }),
    ).toThrow(/must be a string/);
    expect(() =>
      assertLiveChallengeReply(`echo ${STUB_FIXTURE_MARKER} ${token}`, {
        challengeToken: token,
      }),
    ).toThrow(/stub fixture marker/);
  });

  it("fails when the harness-side token is missing (binding must not be theater)", () => {
    expect(() =>
      assertLiveChallengeReply("anything", { challengeToken: "" }),
    ).toThrow(/challenge token is missing/);
  });

  it("attributes the failure to the lane label when provided", () => {
    expect(() =>
      assertLiveChallengeReply("Hello!", {
        challengeToken: token,
        label: "ios-cloud-onboarding tap",
      }),
    ).toThrow(/ios-cloud-onboarding tap: /);
  });
});

describe("structural user-turn anchoring", () => {
  const anchorToken = "9f8e7d";

  it("selects a valid assistant row after the exact token-bearing user row without requiring an echo", () => {
    expect(
      findAnchoredLiveTurn(
        [
          { role: "assistant", text: "cached greeting", phase: "reply" },
          {
            role: "user",
            text: `Reply with exactly this code: ${anchorToken}`,
          },
          { role: "assistant", text: "", phase: "status" },
          {
            role: "assistant",
            text: "Hello from the live model",
            phase: "reply",
          },
        ],
        { anchorToken },
      ),
    ).toEqual({
      userLineIndex: 1,
      assistantLineIndex: 3,
      reply: "Hello from the live model",
    });
  });

  it("rejects failure/retry rows and never crosses into a later user turn", () => {
    expect(
      findAnchoredLiveTurn(
        [
          { role: "user", text: `challenge ${anchorToken}` },
          {
            role: "assistant",
            text: "failed",
            failureKind: "handler_error",
          },
          { role: "assistant", text: "retry", hasRetry: true },
          { role: "user", text: "a later turn" },
          { role: "assistant", text: "later answer", phase: "reply" },
        ],
        { anchorToken },
      ),
    ).toBeNull();
  });

  it("fails closed without a token-bearing user row or a later valid assistant row", () => {
    expect(
      findAnchoredLiveTurn(
        [{ role: "assistant", text: anchorToken, phase: "reply" }],
        { anchorToken },
      ),
    ).toBeNull();
    expect(
      findAnchoredLiveTurn([{ role: "user", text: anchorToken }], {
        anchorToken,
      }),
    ).toBeNull();
    expect(
      findAnchoredLiveTurn(
        [
          { role: "user", text: anchorToken },
          { role: "assistant", text: "answer", phase: "reply" },
        ],
        { anchorToken: "" },
      ),
    ).toBeNull();
  });
});

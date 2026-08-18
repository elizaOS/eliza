// @vitest-environment jsdom
// Unit test for the iOS cloud-onboarding smoke contract helpers (#16936):
// request parsing, direct-Cloud completion, and the fail-closed reply-row
// classification the in-app liveness driver relies on. Deterministic, jsdom —
// no simulator or Playwright harness; the overlay DOM shapes below mirror the
// real renderer (`overlay-assistant-turn-body` phases from
// packages/ui/src/components/shell/chat-overlay-transcript.tsx).
import { describe, expect, it } from "vitest";

import {
  extractIosLivenessChallengeToken,
  isIosCloudOnboardingComplete,
  isIosLivenessReplyRow,
  parseIosCloudOnboardingSmokeRequest,
} from "../src/ios-cloud-onboarding-smoke";

describe("isIosCloudOnboardingComplete", () => {
  const completeState = {
    homeVisible: true,
    composerVisible: true,
    onboardingHidden: true,
    cloudActiveServer: true,
    firstRunPostCount: 0,
  };

  it("accepts durable direct-Cloud completion without an app-shell POST", () => {
    expect(isIosCloudOnboardingComplete(completeState)).toBe(true);
  });

  it("rejects the retired /api/first-run completion shape", () => {
    expect(
      isIosCloudOnboardingComplete({
        ...completeState,
        firstRunPostCount: 1,
      }),
    ).toBe(false);
  });

  it.each([
    "homeVisible",
    "composerVisible",
    "onboardingHidden",
    "cloudActiveServer",
  ] as const)("requires %s", (field) => {
    expect(
      isIosCloudOnboardingComplete({ ...completeState, [field]: false }),
    ).toBe(false);
  });
});

function overlayRow(phase: "status" | "reply", text: string): Element {
  const row = document.createElement("div");
  row.setAttribute("data-testid", "thread-line");
  row.setAttribute("data-role", "assistant");
  const body = document.createElement("div");
  body.setAttribute("data-testid", "overlay-assistant-turn-body");
  body.setAttribute("data-phase", phase);
  body.textContent = text;
  row.appendChild(body);
  return row;
}

function bareRow(text: string): Element {
  // A surface without the overlay body marker (e.g. the plain chat list).
  const row = document.createElement("div");
  row.setAttribute("data-role", "assistant");
  row.textContent = text;
  return row;
}

describe("parseIosCloudOnboardingSmokeRequest", () => {
  it("defaults a missing or bare request to the tap lane with the hello prompt", () => {
    for (const raw of [null, "", "1"]) {
      expect(parseIosCloudOnboardingSmokeRequest(raw)).toEqual({
        mode: "tap",
        livenessPrompt: "In one short sentence, say hello.",
      });
    }
  });

  it("parses mode and livenessPrompt from a well-formed request", () => {
    expect(
      parseIosCloudOnboardingSmokeRequest(
        JSON.stringify({
          mode: "autologin",
          livenessPrompt:
            "Reply with exactly this code to confirm you are live: ab12cd",
        }),
      ),
    ).toEqual({
      mode: "autologin",
      livenessPrompt:
        "Reply with exactly this code to confirm you are live: ab12cd",
    });
  });

  it("falls back per-field on malformed values (liveness is never optional)", () => {
    expect(
      parseIosCloudOnboardingSmokeRequest(
        JSON.stringify({ mode: "weird", livenessPrompt: "   " }),
      ),
    ).toEqual({
      mode: "tap",
      livenessPrompt: "In one short sentence, say hello.",
    });
    expect(
      parseIosCloudOnboardingSmokeRequest(
        JSON.stringify({ livenessPrompt: 42 }),
      ),
    ).toEqual({
      mode: "tap",
      livenessPrompt: "In one short sentence, say hello.",
    });
  });

  it("throws on a corrupt JSON blob — corrupt input cannot drive a valid path", () => {
    expect(() => parseIosCloudOnboardingSmokeRequest("{not json")).toThrow(
      /Invalid iOS cloud-onboarding smoke request/,
    );
  });
});

describe("extractIosLivenessChallengeToken", () => {
  it("extracts and lowercases the run token from a challenge prompt", () => {
    expect(
      extractIosLivenessChallengeToken(
        "Reply with exactly this code to confirm you are live: F00D42",
      ),
    ).toBe("f00d42");
  });

  it("returns an empty token for a tokenless prompt (hello fallback)", () => {
    expect(
      extractIosLivenessChallengeToken("In one short sentence, say hello."),
    ).toBe("");
  });
});

describe("isIosLivenessReplyRow (fail-closed reply classification)", () => {
  it("rejects pending status rows — the P0 fail-open from the review", () => {
    expect(isIosLivenessReplyRow(overlayRow("status", "Thinking"))).toBe(false);
    expect(isIosLivenessReplyRow(overlayRow("status", ""))).toBe(false);
  });

  it("accepts reply-phase rows with real content", () => {
    expect(
      isIosLivenessReplyRow(overlayRow("reply", "The code is ab12cd")),
    ).toBe(true);
  });

  it("accepts rows on surfaces without the overlay marker — their typing indicators never match the assistant selector", () => {
    // On the plain chat list and the shell surface, the pending-turn indicator
    // (TypingIndicator) renders as a sibling element without data-role, so a
    // row that DOES match the assistant selector there always holds a real,
    // completed message — including prose that begins with a status-ish word.
    // The review's "Thinking · 1s" fail-open exists only on the overlay, where
    // data-phase handles it (see the pending-status test above).
    expect(isIosLivenessReplyRow(bareRow("Thinking about it — sure!"))).toBe(
      true,
    );
    expect(isIosLivenessReplyRow(bareRow("Running your task now — done"))).toBe(
      true,
    );
    expect(isIosLivenessReplyRow(bareRow("Hello from the model"))).toBe(true);
  });

  it("handles null/undefined rows fail-closed", () => {
    expect(isIosLivenessReplyRow(null)).toBe(false);
    expect(isIosLivenessReplyRow(undefined)).toBe(false);
  });
});

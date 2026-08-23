/**
 * Covers chat-send failure classification and optimistic-turn reconciliation.
 *
 * The notice a user sees has to match what actually went wrong, because each
 * one prescribes a different action (sign in again / wait / just resend). The
 * ordering inside `buildSendFailureNotice` is therefore load-bearing: an auth
 * or throttle status must win over a transport `kind`, and a validation status
 * must only surface the server's own text when there is real text to surface —
 * a bare "HTTP 400" would tell the user nothing while displacing the generic
 * advice.
 *
 * Pure policy — no React, no network.
 */
import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../api";
import {
  buildSendFailureNotice,
  getSendValidationFailureMessage,
  resolveAbortRoomId,
  sentUserTurnPresent,
  UNDELIVERED_TURN_NOTICE,
} from "./chat-send-failures.ts";

const httpError = (status: number, message = ""): Error & { status: number } =>
  Object.assign(new Error(message), { status });

const message = (
  text: string,
  timestamp: number,
  role: "user" | "assistant" = "user",
): ConversationMessage => ({ role, text, timestamp }) as ConversationMessage;

describe("getSendValidationFailureMessage", () => {
  it("surfaces the server text for each validation status", () => {
    for (const status of [400, 413, 415, 422]) {
      expect(
        getSendValidationFailureMessage(httpError(status, "Too many parts")),
      ).toBe("Too many parts");
    }
  });

  it("ignores non-validation statuses", () => {
    for (const status of [401, 403, 429, 500, 503]) {
      expect(
        getSendValidationFailureMessage(httpError(status, "nope")),
      ).toBeNull();
    }
  });

  it("ignores a placeholder message that carries no information", () => {
    // "HTTP 400" would displace the generic advice while saying nothing.
    expect(
      getSendValidationFailureMessage(httpError(400, "HTTP 400")),
    ).toBeNull();
    expect(
      getSendValidationFailureMessage(httpError(400, "http 422")),
    ).toBeNull();
  });

  it("ignores an empty or whitespace-only message", () => {
    expect(getSendValidationFailureMessage(httpError(400, ""))).toBeNull();
    expect(getSendValidationFailureMessage(httpError(400, "   "))).toBeNull();
  });

  it("trims the surfaced message", () => {
    expect(
      getSendValidationFailureMessage(httpError(400, "  bad input  ")),
    ).toBe("bad input");
  });

  it("tolerates a non-Error and a status-less value", () => {
    expect(getSendValidationFailureMessage({ status: 400 })).toBeNull();
    expect(getSendValidationFailureMessage(null)).toBeNull();
    expect(getSendValidationFailureMessage("nope")).toBeNull();
  });
});

describe("buildSendFailureNotice", () => {
  it("tells the user to sign in again on an auth failure", () => {
    for (const status of [401, 403]) {
      expect(buildSendFailureNotice(httpError(status))).toContain(
        "sign in again",
      );
    }
  });

  it("tells the user to wait on a throttle", () => {
    expect(buildSendFailureNotice(httpError(429))).toContain("busy");
  });

  it("tells the user the agent is waking up on a gateway failure", () => {
    for (const status of [502, 503]) {
      expect(buildSendFailureNotice(httpError(status))).toContain("waking up");
    }
  });

  it("quotes the server's reason for a validation failure", () => {
    expect(buildSendFailureNotice(httpError(422, "Attachment too large"))).toBe(
      "The agent couldn't accept that message: Attachment too large.",
    );
  });

  it("prefers an auth or throttle status over a transport kind", () => {
    // Ordering matters: the actionable advice differs.
    expect(
      buildSendFailureNotice(
        Object.assign(httpError(401), { kind: "network" }),
      ),
    ).toContain("sign in again");
    expect(
      buildSendFailureNotice(
        Object.assign(httpError(429), { kind: "timeout" }),
      ),
    ).toContain("busy");
  });

  it("falls back to the transport kind when there is no status", () => {
    expect(buildSendFailureNotice({ kind: "timeout" })).toContain(
      "took too long",
    );
    expect(buildSendFailureNotice({ kind: "network" })).toContain(
      "Couldn't reach the agent",
    );
  });

  it("falls back to the generic notice for an unrecognized failure", () => {
    for (const err of [
      new Error("boom"),
      httpError(500),
      {},
      null,
      undefined,
    ]) {
      expect(buildSendFailureNotice(err)).toBe(
        "That message didn't go through — please resend.",
      );
    }
  });

  it("falls back to generic when a validation status carries no usable text", () => {
    expect(buildSendFailureNotice(httpError(400, "HTTP 400"))).toBe(
      "That message didn't go through — please resend.",
    );
  });

  it("always returns a non-empty notice", () => {
    for (const err of [null, undefined, {}, new Error(""), httpError(418)]) {
      expect(buildSendFailureNotice(err).length).toBeGreaterThan(0);
    }
  });

  it("exposes a distinct undelivered-turn notice", () => {
    expect(UNDELIVERED_TURN_NOTICE).not.toBe(
      buildSendFailureNotice(new Error("x")),
    );
    expect(UNDELIVERED_TURN_NOTICE.length).toBeGreaterThan(0);
  });
});

describe("resolveAbortRoomId", () => {
  it("prefers the known room id", () => {
    expect(resolveAbortRoomId("conv", "room", "cached")).toBe("room");
  });

  it("falls back to the cached id, then to the conversation id", () => {
    expect(resolveAbortRoomId("conv", null, "cached")).toBe("cached");
    expect(resolveAbortRoomId("conv", null, null)).toBe("conv");
    expect(resolveAbortRoomId("conv", undefined, undefined)).toBe("conv");
  });

  it("treats a whitespace-only id as absent", () => {
    expect(resolveAbortRoomId("conv", "   ", "cached")).toBe("cached");
    expect(resolveAbortRoomId("conv", "   ", "   ")).toBe("conv");
  });

  it("trims the id it returns", () => {
    expect(resolveAbortRoomId("conv", "  room  ", null)).toBe("room");
  });
});

describe("sentUserTurnPresent", () => {
  const SENT_AT = 1_800_000_000_000;

  it("finds a matching user turn at the send time", () => {
    expect(
      sentUserTurnPresent([message("hello", SENT_AT)], "hello", SENT_AT),
    ).toBe(true);
  });

  it("matches within the slack window but not before it", () => {
    expect(
      sentUserTurnPresent(
        [message("hello", SENT_AT - 59_000)],
        "hello",
        SENT_AT,
      ),
    ).toBe(true);
    expect(
      sentUserTurnPresent(
        [message("hello", SENT_AT - 61_000)],
        "hello",
        SENT_AT,
      ),
    ).toBe(false);
  });

  it("ignores assistant turns with the same text", () => {
    expect(
      sentUserTurnPresent(
        [message("hello", SENT_AT, "assistant")],
        "hello",
        SENT_AT,
      ),
    ).toBe(false);
  });

  it("compares trimmed text on both sides", () => {
    expect(
      sentUserTurnPresent([message("  hello  ", SENT_AT)], "hello", SENT_AT),
    ).toBe(true);
    expect(
      sentUserTurnPresent([message("hello", SENT_AT)], "  hello  ", SENT_AT),
    ).toBe(true);
  });

  it("does not match different text", () => {
    expect(
      sentUserTurnPresent([message("hello there", SENT_AT)], "hello", SENT_AT),
    ).toBe(false);
  });

  it("reports absent for an empty history", () => {
    expect(sentUserTurnPresent([], "hello", SENT_AT)).toBe(false);
  });
});

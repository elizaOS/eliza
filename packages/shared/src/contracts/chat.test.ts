/** Validates chat failure parsing and retry decisions against real shared helpers. */
import { describe, expect, it } from "vitest";
import {
  CHAT_FAILURE_KINDS,
  isChatFailureKind,
  isRetryableChatFailureKind,
  parseChatFailureKind,
  parseChatTerminalFailure,
} from "./chat.js";

describe("ChatFailureKind contract", () => {
  it("validates every public kind and rejects unknowns", () => {
    for (const kind of CHAT_FAILURE_KINDS) {
      expect(isChatFailureKind(kind)).toBe(true);
      expect(parseChatFailureKind(kind)).toBe(kind);
    }
    expect(isChatFailureKind("transient_failure")).toBe(false);
    expect(isChatFailureKind("not_a_kind")).toBe(false);
    expect(parseChatFailureKind("generation_timeout")).toBe(
      "generation_timeout",
    );
    expect(parseChatFailureKind(undefined)).toBeUndefined();
  });

  it("marks only recoverable kinds retryable for UI contracts", () => {
    expect(isRetryableChatFailureKind("planner_exhaustion")).toBe(true);
    expect(isRetryableChatFailureKind("generation_timeout")).toBe(true);
    expect(isRetryableChatFailureKind("missing_capability")).toBe(false);
    expect(isRetryableChatFailureKind("context_overflow")).toBe(false);
    expect(isRetryableChatFailureKind("no_provider")).toBe(false);
    expect(isRetryableChatFailureKind("reply_generation_error")).toBe(false);
    expect(isRetryableChatFailureKind("insufficient_credits")).toBe(false);
    expect(isRetryableChatFailureKind("coding_mutation_unverified")).toBe(
      false,
    );
    expect(isRetryableChatFailureKind("coding_verification_failed")).toBe(
      false,
    );
    expect(isRetryableChatFailureKind("coding_tool_failure")).toBe(false);
  });

  it("validates complete terminal failures without inventing missing fields", () => {
    expect(
      parseChatTerminalFailure({
        kind: "coding_verification_failed",
        message: "Typecheck still fails.",
        transient: false,
        code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
      }),
    ).toEqual({
      kind: "coding_verification_failed",
      message: "Typecheck still fails.",
      transient: false,
      code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
    });
    expect(
      parseChatTerminalFailure({
        kind: "coding_tool_failure",
        message: "",
        transient: false,
      }),
    ).toBeUndefined();
    expect(
      parseChatTerminalFailure({
        kind: "unknown",
        message: "Failed.",
        transient: false,
      }),
    ).toBeUndefined();
  });
});

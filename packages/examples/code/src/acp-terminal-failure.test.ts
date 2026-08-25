/** Tests the typed failure receipt exported by the eliza-code ACP boundary. */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { terminalFailureFromAgentClientError } from "./acp-terminal-failure.js";

describe("terminalFailureFromAgentClientError", () => {
  it("preserves kind, code, retryability, and complete message", () => {
    const error = new ElizaError("Verification did not complete.", {
      code: "ELIZA_CODE_SYNTHETIC_TURN_FAILURE",
      context: {
        failureKind: "coding_mutation_unverified",
        failureCode: "VERIFY_REQUIRED",
        transient: false,
      },
      severity: "fatal",
    });

    expect(terminalFailureFromAgentClientError(error)).toEqual({
      kind: "coding_mutation_unverified",
      code: "VERIFY_REQUIRED",
      transient: false,
      message: "Verification did not complete.",
    });
  });

  it("does not translate unrelated failures", () => {
    expect(
      terminalFailureFromAgentClientError(new Error("transport failed")),
    ).toBeUndefined();
  });
});

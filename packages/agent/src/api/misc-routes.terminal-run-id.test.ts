/**
 * Exercises terminal run identity normalization at the HTTP boundary with
 * deterministic inputs and no live shell execution.
 */

import { describe, expect, it } from "vitest";
import { resolveRequestedTerminalRunId } from "./terminal-run-limits.ts";

describe("terminal run identity", () => {
  it("preserves a valid caller-selected run identity", () => {
    expect(
      resolveRequestedTerminalRunId("run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e"),
    ).toBe("run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e");
  });

  it("rejects malformed or ambiguous header values", () => {
    expect(resolveRequestedTerminalRunId("run-not-a-uuid")).toBeNull();
    expect(
      resolveRequestedTerminalRunId([
        "run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
      ]),
    ).toBeNull();
  });

  it("generates a run identity for existing callers that omit the header", () => {
    expect(resolveRequestedTerminalRunId(undefined)).toMatch(
      /^run-[0-9a-f-]{36}$/u,
    );
  });
});

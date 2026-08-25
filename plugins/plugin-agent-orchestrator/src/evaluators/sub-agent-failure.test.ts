/**
 * Unit tests for sub-agent failure evaluator: validates failure reason parsing
 * and evaluator metadata.
 */
import { describe, expect, it } from "vitest";
import {
  extractFailureReason,
  subAgentFailureResponseEvaluator,
} from "./sub-agent-failure.ts";

describe("sub-agent-failure", () => {
  it("extracts clean failure reason clause from error text", () => {
    const raw = "[ERROR] Process failed with exit code 1\nDetailed stack trace";
    const reason = extractFailureReason(raw);
    expect(reason).toBe("Process failed with exit code 1");
  });

  it("returns empty string when no valid line exists", () => {
    expect(extractFailureReason("")).toBe("");
    expect(extractFailureReason("   ")).toBe("");
  });

  it("defines response handler evaluator with priority and name", () => {
    expect(subAgentFailureResponseEvaluator.name).toBe(
      "agent-orchestrator.sub-agent-failure",
    );
    expect(subAgentFailureResponseEvaluator.priority).toBe(10);
  });
});

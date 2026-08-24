/**
 * Unit tests for subagent stdout log: validates file path generation and logging policy check.
 */
import { describe, expect, it } from "vitest";
import {
  isSubagentStdoutLoggingEnabled,
  subagentStdoutLogPath,
} from "./subagent-stdout-log.ts";

describe("subagent-stdout-log", () => {
  it("generates stable NDJSON log path under trajectory root", () => {
    const path = subagentStdoutLogPath("session-abc-123");
    expect(path).toContain("subagent-stdout");
    expect(path).toContain("session-abc-123.ndjson");
  });

  it("sanitizes unsafe characters in session IDs", () => {
    const path = subagentStdoutLogPath("session/../../hack:123");
    expect(path).not.toContain("/../../");
    expect(path).toContain("session_.._.._hack_123.ndjson");
  });

  it("checks trajectory recording enablement status", () => {
    const enabled = isSubagentStdoutLoggingEnabled();
    expect(typeof enabled).toBe("boolean");
  });
});

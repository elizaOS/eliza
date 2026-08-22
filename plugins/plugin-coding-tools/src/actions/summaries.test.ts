/** Unit tests for the operation-summary string helpers. */
import { describe, expect, it } from "vitest";
import {
  preserveSummaryText,
  summarizeFileOperation,
  summarizeShellCommand,
} from "./summaries.js";

describe("coding tool planner summaries", () => {
  it("summarizes write and edit file operations", () => {
    expect(
      summarizeFileOperation({
        action: "write",
        file_path: "/workspace/src/app.ts",
      }),
    ).toBe("wrote app.ts");
    expect(
      summarizeFileOperation({
        action: "edit",
        path: "/workspace/src/app.ts",
      }),
    ).toBe("edited app.ts");
    expect(
      summarizeFileOperation({
        action: "read",
        file_path: "/workspace/src/app.ts",
      }),
    ).toBeUndefined();
  });

  it("summarizes shell commands without shortening them", () => {
    expect(summarizeShellCommand("bun test")).toBe("ran `bun test`");
    const command =
      "bun run test --filter very-long-package-name -- --reporter verbose";
    expect(preserveSummaryText(command)).toBe(command);
    expect(summarizeShellCommand(command)).toBe(`ran \`${command}\``);
  });
  it("sanitizes either lone surrogate half without shortening content", () => {
    for (const s of ["a\ud800bc", "a\udc00bc"]) {
      const out = preserveSummaryText(s);
      expect(out).toBe("a\ufffdbc");
      expect(out.isWellFormed()).toBe(true);
    }
  });
});

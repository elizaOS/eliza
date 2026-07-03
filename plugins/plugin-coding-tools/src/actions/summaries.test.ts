import { describe, expect, it } from "vitest";
import {
  compactSummaryText,
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

  it("summarizes shell commands with bounded text", () => {
    expect(summarizeShellCommand({ command: "bun test" })).toBe(
      "ran `bun test`",
    );
    expect(
      compactSummaryText(
        "bun run test --filter very-long-package-name -- --reporter verbose",
        20,
      ),
    ).toBe("bun run test --filt…");
  });
});

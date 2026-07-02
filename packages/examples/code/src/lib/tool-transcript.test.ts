import { describe, expect, test } from "bun:test";
import { type ActionEventPayload, stringToUuid } from "@elizaos/core";
import {
  formatToolCompleted,
  formatToolStarted,
  shouldShowToolAction,
} from "./tool-transcript.js";

function payload(args: {
  action: string;
  data?: Record<string, unknown>;
  text?: string;
  success?: boolean;
}): ActionEventPayload {
  return Object.assign(Object.create(null) as ActionEventPayload, {
    roomId: stringToUuid("room"),
    world: stringToUuid("world"),
    content: {
      actions: [args.action],
      actionResult: {
        success: args.success ?? true,
        ...(args.text ? { text: args.text } : {}),
        ...(args.data ? { data: args.data } : {}),
      },
    },
  });
}

describe("tool transcript formatting (#11330)", () => {
  test("formats edit result line counts", () => {
    expect(
      formatToolCompleted(
        payload({
          action: "FILE",
          data: {
            path: "/workspace/src/foo.ts",
            replacements: 1,
            addedLines: 2,
            removedLines: 1,
          },
        }),
        { cwd: "/workspace" },
      ),
    ).toBe("edit src/foo.ts +2/-1");
  });

  test("formats shell commands from structured data or result text", () => {
    expect(
      formatToolCompleted(
        payload({
          action: "SHELL",
          data: { command: "bun test", exit_code: 0 },
        }),
      ),
    ).toBe("run bun test exited 0");

    expect(
      formatToolCompleted(
        payload({
          action: "SHELL",
          text: "$ git status\n[exit 0]",
        }),
      ),
    ).toBe("run git status");
  });

  test("hides terminal protocol actions", () => {
    expect(shouldShowToolAction("REPLY")).toBe(false);
    expect(formatToolStarted("FILE")).toBe("tool file");
  });
});

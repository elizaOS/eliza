/**
 * The tool ledger bridge is tested on the runtime's ACTION_COMPLETED content
 * shape: SHELL runs and FILE writes become verifiable ACP tool calls, reads and
 * non-coding actions contribute nothing.
 */

import { describe, expect, it } from "bun:test";
import type { Content } from "@elizaos/core";
import { toolCallUpdateFromAction } from "./acp-tool-ledger.js";

function completed(
  action: string,
  text: string,
  data: Record<string, unknown>,
): Content {
  return {
    text,
    actions: [action],
    actionStatus: "completed",
    actionResult: { success: true, text, data },
  } as unknown as Content;
}

describe("ACP tool ledger bridge", () => {
  it("turns a SHELL run into an execute tool call with the command and transcript", () => {
    const text =
      "$ python3 /ws/pick.py\n[exit 0] (cwd=/ws, took=35ms)\n--- stdout ---\nApple\n";
    const update = toolCallUpdateFromAction(
      "s1",
      completed("SHELL", text, {
        command: "python3 /ws/pick.py",
        exit_code: 0,
        cwd: "/ws",
      }),
      "call-1",
    );
    expect(update).toEqual({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "$ python3 /ws/pick.py",
        kind: "execute",
        status: "completed",
        rawInput: { command: "python3 /ws/pick.py", cwd: "/ws" },
        rawOutput: text,
      },
    });
  });

  it("turns a FILE write into an edit tool call carrying the path as a location", () => {
    const update = toolCallUpdateFromAction(
      "s1",
      completed("FILE", "Wrote 133 bytes to /ws/pick.py", {
        action: "FILE",
        operation: "write",
        path: "/ws/pick.py",
        bytes: 133,
      }),
      "call-2",
    );
    expect(update?.update).toMatchObject({
      kind: "edit",
      status: "completed",
      rawInput: { path: "/ws/pick.py", operation: "write" },
      locations: [{ path: "/ws/pick.py" }],
      rawOutput: "Wrote 133 bytes to /ws/pick.py",
    });
  });

  it("marks a failed action failed", () => {
    const content = {
      ...completed("SHELL", "$ false\n[exit 1]", {
        command: "false",
        exit_code: 1,
      }),
      actionStatus: "failed",
    } as unknown as Content;
    expect(toolCallUpdateFromAction("s1", content, "c")?.update.status).toBe(
      "failed",
    );
  });

  it("ignores reads, listings, and non-coding actions", () => {
    expect(
      toolCallUpdateFromAction(
        "s1",
        completed("FILE", "contents", {
          operation: "read",
          path: "/ws/pick.py",
        }),
        "c",
      ),
    ).toBeUndefined();
    for (const operation of ["grep", "glob", "search", "stat", "ls"]) {
      expect(
        toolCallUpdateFromAction(
          "s1",
          completed("FILE", "observed", {
            operation,
            path: "/ws/pick.py",
          }),
          `read-${operation}`,
        ),
      ).toBeUndefined();
    }
    expect(
      toolCallUpdateFromAction(
        "s1",
        completed("WEB_FETCH", "page", { url: "x" }),
        "c",
      ),
    ).toBeUndefined();
    expect(
      toolCallUpdateFromAction(
        "s1",
        completed("SHELL", "poll", { handle: "bg-1" }),
        "c",
      ),
    ).toBeUndefined();
  });
});

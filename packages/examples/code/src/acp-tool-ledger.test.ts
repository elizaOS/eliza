/**
 * The tool ledger bridge is tested on the runtime's ACTION_COMPLETED content
 * shape: shell and direct or umbrella file mutations become verifiable ACP
 * tool calls, while reads and non-coding actions contribute nothing.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Content } from "@elizaos/core";
import { setupEnv } from "@elizaos/plugin-coding-tools/actions/_test-helpers";
import {
  editAction,
  writeAction,
} from "@elizaos/plugin-coding-tools/actions/index";
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

  it.each(["WRITE", "EDIT"])(
    "turns %s success and failure into located edit receipts",
    (action) => {
      const path = `/ws/${action.toLowerCase()}.ts`;
      for (const actionStatus of ["completed", "failed"] as const) {
        const content = {
          ...completed(action, `${action} result for ${path}`, { path }),
          actionStatus,
          actionResult: {
            success: actionStatus === "completed",
            text: `${action} result for ${path}`,
            data: { path },
          },
        } as unknown as Content;

        expect(
          toolCallUpdateFromAction("s1", content, `${action}-${actionStatus}`),
        ).toMatchObject({
          update: {
            title: `${action} ${path}`,
            kind: "edit",
            status: actionStatus,
            rawInput: { path },
            locations: [{ path }],
            rawOutput: `${action} result for ${path}`,
          },
        });
      }
    },
  );

  it("preserves real failed WRITE and EDIT paths through completion receipts", async () => {
    const env = await setupEnv("acp-ledger-failure");
    try {
      const file = path.join(env.tmpDir, "existing.ts");
      await fs.writeFile(file, "const value = 1;\n", "utf8");
      await env.fileState.recordRead("test-room", file);

      const cases = [
        {
          action: writeAction,
          name: "WRITE",
          parameters: { file_path: file, content: "replacement" },
        },
        {
          action: editAction,
          name: "EDIT",
          parameters: {
            file_path: file,
            old_string: "missing text",
            new_string: "replacement",
          },
        },
      ] as const;

      for (const entry of cases) {
        const result = await entry.action.handler(
          env.runtime,
          env.message,
          undefined,
          { parameters: entry.parameters },
          undefined,
          undefined,
        );
        if (!result) throw new Error(`${entry.name} returned no ActionResult`);
        expect(result.success).toBe(false);
        expect(result.data).toMatchObject({ path: file });

        const completion = {
          text: result.text,
          actions: [entry.name],
          actionStatus: "failed",
          actionResult: result,
        } as unknown as Content;
        expect(
          toolCallUpdateFromAction(
            "s1",
            completion,
            `${entry.name}-actual-failure`,
          ),
        ).toMatchObject({
          update: {
            status: "failed",
            locations: [{ path: file }],
          },
        });
      }
    } finally {
      await env.cleanup();
    }
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

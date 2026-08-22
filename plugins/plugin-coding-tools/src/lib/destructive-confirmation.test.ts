/**
 * Exercises the deterministic destructive-command confirmation authority in
 * memory, including one-use consumption and execution-directory binding.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  consumeDestructiveChallenge,
  issueDestructiveChallenge,
} from "./destructive-confirmation.js";

const runtime = {} as IAgentRuntime;

function message(id: string, text: string): Memory {
  return {
    id: id as UUID,
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    entityId: "22222222-2222-2222-2222-222222222222" as UUID,
    roomId: "33333333-3333-3333-3333-333333333333" as UUID,
    content: { text },
    createdAt: 1,
  } as Memory;
}

describe("destructive confirmation execution context", () => {
  it("rejects a changed cwd without consuming the original authority", () => {
    const command = "rm -rf ./relative-target";
    const issuedFrom = message(
      "44444444-4444-4444-4444-444444444444",
      "remove the relative target",
    );
    const token = issueDestructiveChallenge({
      runtime,
      command,
      executionDirectory: "/workspace/original",
      message: issuedFrom,
      now: 1,
    });
    expect(typeof token).toBe("string");
    const confirmedFrom = message(
      "55555555-5555-5555-5555-555555555555",
      `confirm ${token}`,
    );

    expect(
      consumeDestructiveChallenge({
        runtime,
        token,
        command,
        executionDirectory: "/workspace/changed",
        message: confirmedFrom,
        now: 2,
      }),
    ).toEqual({ authorized: false, reason: "cwd_mismatch" });
    expect(
      consumeDestructiveChallenge({
        runtime,
        token,
        command,
        executionDirectory: "/workspace/original",
        message: confirmedFrom,
        now: 2,
      }),
    ).toEqual({ authorized: true });
    expect(
      consumeDestructiveChallenge({
        runtime,
        token,
        command,
        executionDirectory: "/workspace/original",
        message: confirmedFrom,
        now: 2,
      }),
    ).toEqual({ authorized: false, reason: "missing" });
  });
});

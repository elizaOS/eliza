// Exercises oauth behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { oauthAction } from "./oauth";

function message(content: Record<string, unknown>): Memory {
  return {
    agentId: "agent-1",
    entityId: "user-1",
    roomId: "room-1",
    content,
  } as Memory;
}

const runtime = {} as IAgentRuntime;

describe("OAUTH structured op routing (#10471)", () => {
  test("does not infer revoke intent from raw English message text", async () => {
    const result = await oauthAction.handler(runtime, message({ text: "disconnect google" }));

    expect(result.success).toBe(false);
    expect(result.text).toContain("OAUTH could not determine the operation");
    expect(result.values).toEqual({ error: "MISSING" });
  });

  test("does not infer status intent from raw English completion text", async () => {
    const result = await oauthAction.handler(runtime, message({ text: "did it work?" }));

    expect(result.success).toBe(false);
    expect(result.text).toContain("OAUTH could not determine the operation");
    expect(result.values).toEqual({ error: "MISSING" });
  });

  test("uses structured op params even when message text is non-English", async () => {
    const result = await oauthAction.handler(
      runtime,
      message({
        text: "conecta mi cuenta",
        actionParams: { op: "connect" },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("MISSING_PLATFORM");
    expect(result.data).toMatchObject({ actionName: "OAUTH", op: "connect" });
  });

  test("uses legacy structured action metadata without parsing message text", async () => {
    const result = await oauthAction.handler(
      runtime,
      message({
        text: "quita mi cuenta",
        action: "OAUTH_REVOKE",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("MISSING_PLATFORM");
    expect(result.data).toMatchObject({ actionName: "OAUTH", op: "revoke" });
  });
});

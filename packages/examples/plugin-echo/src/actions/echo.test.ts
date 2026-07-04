/**
 * Unit coverage for the echo example action validator and callback result.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { echoAction } from "./echo.ts";

const runtime = {} as IAgentRuntime;

function messageWith(text: string | undefined): Memory {
  return { content: { text } } as Memory;
}

describe("echoAction", () => {
  it("validates when there is message text", async () => {
    expect(await echoAction.validate(runtime, messageWith("hi"))).toBe(true);
  });

  it("does not validate empty messages", async () => {
    expect(await echoAction.validate(runtime, messageWith(""))).toBe(false);
    expect(await echoAction.validate(runtime, messageWith(undefined))).toBe(
      false,
    );
  });

  it("echoes the message text back via callback and result", async () => {
    const calls: string[] = [];
    const result = await echoAction.handler(
      runtime,
      messageWith("hello world"),
      undefined,
      undefined,
      async (content) => {
        calls.push(content.text ?? "");
        return [];
      },
    );
    expect(calls).toEqual(["hello world"]);
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("hello world");
  });
});

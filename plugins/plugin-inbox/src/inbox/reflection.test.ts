import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { reflectOnAutoReply } from "./reflection.ts";

describe("reflectOnAutoReply", () => {
  it("preserves complete unparseable reflection text with surrogate safety", async () => {
    const rawUnparseable = `${"a".repeat(99)}😀${"b".repeat(20)}`;
    const runtime = {
      useModel: vi.fn().mockResolvedValue(rawUnparseable),
    } as unknown as IAgentRuntime;

    const result = await reflectOnAutoReply(runtime, {
      senderName: "Alice",
      source: "email",
      inboundText: "Hello there",
      replyText: "Hi Alice",
    });

    expect(result.approved).toBe(false);
    expect(result.reasoning.startsWith("Could not parse reflection: ")).toBe(
      true,
    );
    expect(result.reasoning).toBe(
      `Could not parse reflection: ${rawUnparseable}`,
    );
    expect(result.reasoning.includes("😀")).toBe(true);
    expect(
      /[\uD800-\uDFFF]/.test(
        result.reasoning.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
      ),
    ).toBe(false);
  });
});

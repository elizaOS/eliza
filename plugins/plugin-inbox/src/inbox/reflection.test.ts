import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { reflectOnAutoReply } from "./reflection.ts";

describe("reflectOnAutoReply", () => {
  it("truncates unparseable reflection text with surrogate safety", async () => {
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
    expect(result.reasoning.includes("😀")).toBe(false);
    expect(result.reasoning.length).toBeLessThanOrEqual(
      "Could not parse reflection: ".length + 100,
    );
    // The invariant the fix is actually about: the old raw.slice(0, 100) cut
    // between the two code units of the astral char and left an unpaired high
    // surrogate. Length and emoji-absence alone hold for the old code too, so
    // assert the absence of unpaired surrogate code units explicitly or this
    // test cannot fail on develop.
    expect(
      /[\uD800-\uDFFF]/.test(
        result.reasoning.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
      ),
    ).toBe(false);
  });
});

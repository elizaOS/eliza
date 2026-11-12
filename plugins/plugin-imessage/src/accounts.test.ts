/** iMessage account id normalization and default account selection. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { normalizeAccountId, resolveDefaultIMessageAccountId } from "./accounts";

describe("iMessage canonical account authoring facade", () => {
  it("preserves lowercase normalization and shared default selection", () => {
    expect(normalizeAccountId(" Local-Mac ")).toBe("local-mac");
    const runtime = {
      character: {
        settings: { imessage: { accounts: { alpha: {}, beta: {} } } },
      },
    } as unknown as IAgentRuntime;
    expect(resolveDefaultIMessageAccountId(runtime)).toBe("alpha");
  });
});

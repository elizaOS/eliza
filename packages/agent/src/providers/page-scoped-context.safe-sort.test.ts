/**
 * Covers the createdAt ordering contract of the real `pruneMainChatTail` helper
 * exported by page-scoped-context.ts. Deterministic and dependency-free: it
 * calls the shipped function directly with plain Memory-shaped rows.
 */
import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { pruneMainChatTail } from "./page-scoped-context.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;

function row(
  id: string,
  createdAt: number,
  role: "user" | "assistant",
): Memory {
  return {
    id: `00000000-0000-0000-0000-00000000${id}` as UUID,
    entityId: role === "assistant" ? AGENT_ID : USER_ID,
    roomId: "00000000-0000-0000-0000-0000000000cc" as UUID,
    createdAt,
    content: { text: `${id}-text` },
  } as unknown as Memory;
}

function textsOf(memories: Memory[]): string[] {
  return memories.map((entry) => entry.content.text ?? "");
}

describe("pruneMainChatTail createdAt ordering", () => {
  it("orders the tail oldest-first so the rendered transcript reads forward", () => {
    const now = 5_000;
    const pruned = pruneMainChatTail(
      [
        row("0003", 3_000, "user"),
        row("0001", 1_000, "user"),
        row("0002", 2_000, "assistant"),
      ],
      AGENT_ID,
      now,
    );
    expect(textsOf(pruned)).toEqual(["0001-text", "0002-text", "0003-text"]);
  });

  it("sorts a non-finite createdAt as oldest instead of scrambling the tail", () => {
    const now = 5_000;
    const pruned = pruneMainChatTail(
      [
        row("0003", 3_000, "user"),
        row("0002", Number.NaN, "assistant"),
        row("0001", 1_000, "user"),
      ],
      AGENT_ID,
      now,
    );
    expect(textsOf(pruned)).toEqual(["0002-text", "0001-text", "0003-text"]);
  });

  it("trims the newest trailing assistant-only run, not the oldest message", () => {
    const now = 5_000;
    const pruned = pruneMainChatTail(
      [
        row("0002", 2_000, "assistant"),
        row("0001", 1_000, "assistant"),
        row("0003", 3_000, "user"),
      ],
      AGENT_ID,
      now,
    );
    expect(textsOf(pruned)).toEqual(["0001-text", "0002-text", "0003-text"]);
  });

  it("drops the tail when the newest user message is older than the max age", () => {
    const pruned = pruneMainChatTail(
      [row("0001", 1_000, "user"), row("0002", 2_000, "assistant")],
      AGENT_ID,
      2_000 + 24 * 60 * 60 * 1000 + 1,
    );
    expect(pruned).toEqual([]);
  });
});

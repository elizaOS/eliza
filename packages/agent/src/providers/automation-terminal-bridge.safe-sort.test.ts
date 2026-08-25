/**
 * Regression coverage for non-finite `createdAt` values in the automation
 * terminal bridge transcript ordering. Exercises the real provider and the real
 * exported `safeCreatedAt` normalizer; only the runtime I/O collaborators
 * (getRoom / getMemories / getWorld) are stubbed. Before the normalizer existed
 * a NaN timestamp made every comparison return NaN, so the sort left the queue
 * in storage order instead of oldest-first.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  automationTerminalBridgeProvider,
  safeCreatedAt,
} from "./automation-terminal-bridge.ts";

const OWNER_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const TERMINAL_CONV_ID = "term-conv-bridge-nan";
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function makeRuntime(memories: Memory[]): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "BridgeAgent" },
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => ({
      id: ROOM_ID,
      metadata: {
        webConversation: {
          conversationId: "auto-room-nan",
          scope: "automation-coordinator",
          terminalBridgeConversationId: TERMINAL_CONV_ID,
        },
      },
    })),
    getMemories: vi.fn(async () => memories),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function ownerMessage(): Memory {
  return {
    id: "00000000-0000-4000-8000-0000000000cc" as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: "status?", source: "test" },
    createdAt: 1_700_000_900_000,
  } as Memory;
}

function terminalMemory(
  id: string,
  text: string,
  displayName: string,
  createdAt: number | undefined,
): Memory {
  return {
    id: id as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: stringToUuid(`web-conv-${TERMINAL_CONV_ID}`) as UUID,
    content: { text, source: "web" },
    createdAt,
    metadata: { displayName },
  } as unknown as Memory;
}

describe("safeCreatedAt", () => {
  it("collapses non-finite and missing timestamps to 0 and keeps finite ones", () => {
    expect(safeCreatedAt(Number.NaN)).toBe(0);
    expect(safeCreatedAt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(safeCreatedAt(undefined)).toBe(0);
    expect(safeCreatedAt(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe("automationTerminalBridgeProvider NaN createdAt ordering", () => {
  it("still renders the transcript oldest-first when a timestamp is NaN", async () => {
    // Storage order is deliberately newest-first so an ineffective comparator
    // (NaN propagating through the subtraction) leaves it reversed.
    const memories = [
      terminalMemory(
        "00000000-0000-4000-8000-000000000403",
        "third",
        "C",
        1_700_000_300_000,
      ),
      terminalMemory(
        "00000000-0000-4000-8000-000000000402",
        "second",
        "B",
        1_700_000_200_000,
      ),
      terminalMemory(
        "00000000-0000-4000-8000-000000000401",
        "broken-ts",
        "A",
        Number.NaN,
      ),
    ];
    const result = await automationTerminalBridgeProvider.get(
      makeRuntime(memories),
      ownerMessage(),
      EMPTY_STATE,
    );

    const texts = (
      result.data as { messages: Array<{ text?: string }> }
    ).messages.map((entry) => entry.text);
    expect(texts).toEqual(["broken-ts", "second", "third"]);

    const lines = (result.text ?? "").split("\n");
    expect(lines[0]).toBe("Linked terminal conversation:");
    expect(lines[1]).toContain("A: broken-ts");
    expect(lines[2]).toContain("B: second");
    expect(lines[3]).toContain("C: third");
  });

  it("keeps every finite entry oldest-first alongside a NaN entry", async () => {
    const memories = [
      terminalMemory(
        "00000000-0000-4000-8000-000000000503",
        "late",
        "C",
        1_700_000_500_000,
      ),
      terminalMemory(
        "00000000-0000-4000-8000-000000000501",
        "nan-a",
        "A",
        Number.NaN,
      ),
      terminalMemory(
        "00000000-0000-4000-8000-000000000502",
        "early",
        "B",
        1_700_000_100_000,
      ),
    ];
    const result = await automationTerminalBridgeProvider.get(
      makeRuntime(memories),
      ownerMessage(),
      EMPTY_STATE,
    );

    const texts = (
      result.data as { messages: Array<{ text?: string }> }
    ).messages.map((entry) => entry.text);
    expect(texts).toEqual(["nan-a", "early", "late"]);
  });
});

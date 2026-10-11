/**
 * Rendered-order contract for the RECENT_MESSAGES provider. The adapter
 * returns room memories newest-first, the provider sorts them oldest-first,
 * and core `formatMessageSegments` walks its input back-to-front. The rendered
 * transcript must read top-down in chronological order: a question appears
 * above the answer it received, and `formattedMessageSegments` must be the
 * exact segments joined into `values.recentMessages`, in that same order.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  addHeader,
  ChannelType,
  conversationMessagesHeader,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it } from "vitest";
import { recentMessagesProvider } from "./recentMessages.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const USER_ID = "00000000-0000-4000-8000-0000000000e1" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const BASE_TIME = 1_760_000_000_000;

function roomMemory(index: number, entityId: UUID, text: string): Memory {
  return {
    id: `00000000-0000-4000-8000-00000000010${index}` as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: BASE_TIME + index * 60_000,
    content: { text, source: "client_chat" },
  };
}

const question = roomMemory(1, USER_ID, "What is the capital of France?");
const answer = roomMemory(2, AGENT_ID, "The capital of France is Paris.");
const followUp = roomMemory(3, USER_ID, "And of Italy?");

function roomRuntime(): IAgentRuntime {
  return createMockRuntime({
    agentId: AGENT_ID,
    getRoom: (async () => ({
      id: ROOM_ID,
      source: "client_chat",
      type: ChannelType.DM,
    })) as IAgentRuntime["getRoom"],
    getEntitiesForRoom: (async () => [
      { id: USER_ID, agentId: AGENT_ID, names: ["Ana"], components: [] },
      { id: AGENT_ID, agentId: AGENT_ID, names: ["Eliza"], components: [] },
    ]) as IAgentRuntime["getEntitiesForRoom"],
    getEntityById: (async () => null) as IAgentRuntime["getEntityById"],
    // The SQL adapter's default room scan orders by createdAt descending.
    getMemories: (async () => [
      followUp,
      answer,
      question,
    ]) as IAgentRuntime["getMemories"],
  });
}

describe("RECENT_MESSAGES rendered order", () => {
  it("renders the room transcript oldest-first, question above answer", async () => {
    const incoming: Memory = {
      id: "00000000-0000-4000-8000-0000000001ff" as UUID,
      entityId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      createdAt: BASE_TIME + 4 * 60_000,
      content: { text: "And of Spain?", source: "client_chat" },
    };

    const result = await recentMessagesProvider.get(roomRuntime(), incoming, {
      values: {},
      data: {},
      text: "",
    });

    const rendered = String(result.values?.recentMessages ?? "");
    expect(rendered.startsWith(conversationMessagesHeader(3))).toBe(true);

    const questionAt = rendered.indexOf("What is the capital of France?");
    const answerAt = rendered.indexOf("The capital of France is Paris.");
    const followUpAt = rendered.indexOf("And of Italy?");
    expect(questionAt).toBeGreaterThan(-1);
    expect(answerAt).toBeGreaterThan(questionAt);
    expect(followUpAt).toBeGreaterThan(answerAt);

    // The provider text carries the same transcript before the received turn.
    const text = result.text ?? "";
    expect(text.indexOf("What is the capital of France?")).toBeLessThan(
      text.indexOf("The capital of France is Paris."),
    );
    expect(text.indexOf("# Received Message")).toBeGreaterThan(
      text.indexOf("And of Italy?"),
    );

    // Segments are the exact rendered entries, oldest first, so readers that
    // number them (h1..hN in failure replies) number chronologically.
    const segments = result.data?.formattedMessageSegments as string[];
    expect(segments).toHaveLength(3);
    expect(segments[0]).toContain("What is the capital of France?");
    expect(segments[1]).toContain("The capital of France is Paris.");
    expect(segments[2]).toContain("And of Italy?");
    expect(rendered).toBe(
      addHeader(conversationMessagesHeader(3), segments.join("\n")),
    );

    // The structured array stays oldest-first for structured readers.
    const recent = (result.data?.recentMessages ?? []) as Memory[];
    const ids = recent.map((m) => m.id);
    expect(ids).toEqual([question.id, answer.id, followUp.id]);
  });
});

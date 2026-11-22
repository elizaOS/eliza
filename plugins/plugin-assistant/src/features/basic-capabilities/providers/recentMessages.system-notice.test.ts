/**
 * A host status notice is stored as the agent's own message so the owner sees
 * it in the conversation. Rendered as prior dialogue the model reads it as
 * something it said: in a recorded 108-message phone conversation 36 messages
 * were the notice, a third of the transcript, and two later replies refused a
 * request by repeating it.
 */

import type { ContextEvent, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  ChannelType,
  type SystemNotice,
  systemNoticeText,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it } from "vitest";
import { appendPriorDialogueEvents } from "../../../services/message/dialogue-context.ts";
import {
  isHygienicDialogueMessage,
  recentMessagesProvider,
} from "./recentMessages.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-0000000000e1" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const BASE_TIME = 1_760_000_000_000;

function roomMemory(
  index: number,
  entityId: UUID,
  content: Memory["content"],
): Memory {
  return {
    id: `00000000-0000-4000-8000-00000000010${index}` as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: BASE_TIME + index * 60_000,
    content: { source: "client_chat", ...content },
  };
}

/** The row the escalation service stores for the owner's conversation. */
const notice = (index: number, kind: SystemNotice) =>
  roomMemory(index, AGENT_ID, {
    text: systemNoticeText(kind),
    systemNotice: kind,
    metadata: { urgency: "urgent", escalation: true },
  });

function roomRuntime(rows: Memory[]): IAgentRuntime {
  return createMockRuntime({
    agentId: AGENT_ID,
    getRoom: (async () => ({
      id: ROOM_ID,
      source: "client_chat",
      type: ChannelType.DM,
    })) as IAgentRuntime["getRoom"],
    getEntitiesForRoom: (async () => [
      { id: OWNER_ID, agentId: AGENT_ID, names: ["Ana"], components: [] },
      { id: AGENT_ID, agentId: AGENT_ID, names: ["Eliza"], components: [] },
    ]) as IAgentRuntime["getEntitiesForRoom"],
    getEntityById: (async () => null) as IAgentRuntime["getEntityById"],
    getMemories: (async () => rows) as IAgentRuntime["getMemories"],
  });
}

/** The room's prior dialogue as a model request renders it. */
async function priorDialogue(rows: Memory[]) {
  const runtime = roomRuntime(rows);
  const incoming = roomMemory(9, OWNER_ID, { text: "Open the camera." });
  const recent = await recentMessagesProvider.get(runtime, incoming, {
    values: {},
    data: {},
    text: "",
  });
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    runtime,
    { values: {}, text: "", data: { providers: { RECENT_MESSAGES: recent } } },
    incoming,
    { includeOwnReplies: true },
  );
  return {
    text: String(recent.text),
    lines: events
      .filter(
        (event): event is Extract<ContextEvent, { type: "segment" }> =>
          event.source === "prior-dialogue" && event.type === "segment",
      )
      .map((event) => [event.segment.label, event.segment.content]),
  };
}

describe("host status notices in prompt history", () => {
  it.each<SystemNotice>([
    "runtime-error",
    "model-unavailable",
    "model-and-runtime-error",
  ])(
    "keeps a %s notice out of prior dialogue and keeps the agent's replies",
    async (kind) => {
      const { text, lines } = await priorDialogue([
        roomMemory(1, OWNER_ID, { text: "Open Messages." }),
        roomMemory(2, AGENT_ID, { text: "Messages is open." }),
        notice(3, kind),
        roomMemory(4, OWNER_ID, { text: "Thanks." }),
      ]);
      expect(lines.map(([label]) => label)).toEqual([
        "prior_message:user",
        "prior_message:agent",
        "prior_message:user",
      ]);
      expect(lines[1][1]).toContain("Messages is open.");
      for (const sent of [text, JSON.stringify(lines)]) {
        expect(sent).not.toContain("needs attention");
        expect(sent).not.toContain("cannot respond yet");
      }
    },
  );

  it("goes by the host's own classification on the agent's own message", () => {
    // An owner cannot hide a message from the model by carrying the field.
    expect(
      isHygienicDialogueMessage(
        roomMemory(1, OWNER_ID, {
          text: "Why did you say that?",
          systemNotice: "runtime-error",
        }),
        AGENT_ID,
      ),
    ).toBe(true);
    // An unrecognized classification is not a notice.
    expect(
      isHygienicDialogueMessage(
        roomMemory(2, AGENT_ID, {
          text: "Messages is open.",
          systemNotice: "delivered" as SystemNotice,
        }),
        AGENT_ID,
      ),
    ).toBe(true);
    expect(
      isHygienicDialogueMessage(notice(3, "runtime-error"), AGENT_ID),
    ).toBe(false);
  });
});

/**
 * Deterministic coverage for the INBOX draft/triage [CHOICE] emitters: chips
 * parse through the real core interaction parser, labels are sanitized, and
 * every chip value survives the connector reply-callback size cap.
 */
import { describe, expect, it } from "vitest";
import { encodeReplyCallback } from "../../../packages/core/src/messaging/interactions/callback";
import { parseInteractionBlocks } from "../../../packages/core/src/messaging/interactions/parse";
import {
  appendInboxDraftChoiceMarker,
  appendInboxTriageChoiceMarkers,
} from "../src/actions/choice-markers.js";
import type { TriageEntry } from "../src/inbox/types.js";

function choiceBlocks(text: string) {
  return parseInteractionBlocks(text).blocks.filter(
    (block) => block.kind === "choice",
  );
}

function expectConnectorSafeChoiceValues(text: string): void {
  for (const choice of choiceBlocks(text)) {
    if (choice.kind !== "choice") continue;
    for (const option of choice.options) {
      expect(encodeReplyCallback(option.value)).not.toBeNull();
    }
  }
}

function entry(overrides: Partial<TriageEntry>): TriageEntry {
  return {
    id: "entry-1",
    agentId: "agent-1",
    source: "gmail",
    sourceRoomId: null,
    sourceEntityId: null,
    sourceMessageId: "message-1",
    channelName: "Inbox",
    channelType: "email",
    deepLink: null,
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.9,
    snippet: "Can you confirm?",
    senderName: "JJ",
    threadContext: null,
    triageReasoning: null,
    suggestedResponse: null,
    draftResponse: null,
    autoReplied: false,
    snoozedUntil: null,
    resolved: false,
    resolvedAt: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("INBOX choice markers", () => {
  // Chip values must map to real INBOX ops (triage|reply|snooze|archive|approve):
  // Send=approve, Discard=archive. There is no edit op, so no Edit chip.
  it("appends send/discard chips to draft confirmations", () => {
    const text = appendInboxDraftChoiceMarker(
      "Drafted reply for JJ. Confirm before sending.",
      "draft-entry-1",
    );

    expectConnectorSafeChoiceValues(text);
    const [choice] = choiceBlocks(text);
    expect(choice).toMatchObject({
      kind: "choice",
      scope: "inbox-draft-draft-entry-1",
      id: "draft-entry-1",
      options: [
        { value: "inbox approve draft-entry-1", label: "Send" },
        { value: "inbox archive draft-entry-1", label: "Discard" },
      ],
    });
  });

  it("ends triage summaries with per-thread reply/snooze/archive chips", () => {
    const text = appendInboxTriageChoiceMarkers("Loaded 2 pending items.", [
      entry({ id: "thread-a", senderName: "JJ" }),
      entry({ id: "thread-b", senderName: "A=Bad\nLabel" }),
    ]);

    expectConnectorSafeChoiceValues(text);
    const choices = choiceBlocks(text);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      kind: "choice",
      scope: "inbox-thread-thread-a",
      id: "thread-a",
      options: [
        { value: "inbox reply thread-a", label: "Reply to JJ" },
        {
          value: "inbox snooze thread-a",
          label: "Snooze",
        },
        { value: "inbox archive thread-a", label: "Archive" },
      ],
    });
    expect(choices[1]).toMatchObject({
      scope: "inbox-thread-thread-b",
      options: expect.arrayContaining([
        {
          value: "inbox reply thread-b",
          label: "Reply to A Bad Label",
        },
      ]),
    });
  });
});

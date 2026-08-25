/**
 * Verifies managed Discord guild ingress with deterministic platform facts.
 * The harness is pure and covers direct, ambient, and other-target routing.
 */

import { describe, expect, test } from "bun:test";
import { managedGuildMessageTurn } from "../src/managed-guild-message-policy";

const BOT_ID = "100000000000000001";
const OTHER_ID = "200000000000000002";

function turn(
  overrides: Partial<Parameters<typeof managedGuildMessageTurn>[0]> = {},
) {
  return managedGuildMessageTurn({
    botUserId: BOT_ID,
    content: "what's going on",
    mentionedUserIds: [],
    ...overrides,
  });
}

describe("managedGuildMessageTurn", () => {
  test("routes ambient follow-ups for contextual runtime evaluation", () => {
    expect(turn()).toEqual({
      content: "what's going on",
      invocation: "ambient",
    });
  });

  test("routes textual by-name messages without requiring a native tag", () => {
    expect(turn({ content: "Eliza, are you awake?" })).toEqual({
      content: "Eliza, are you awake?",
      invocation: "ambient",
    });
  });

  test("routes a native mention and removes only the bot pointer", () => {
    expect(
      turn({
        content: `<@${BOT_ID}> gm`,
        mentionedUserIds: [BOT_ID],
      }),
    ).toEqual({ content: "gm", invocation: "mention" });
  });

  test("routes role calls that mention Eliza alongside other participants", () => {
    expect(
      turn({
        content: `<@${BOT_ID}> <@${OTHER_ID}> role call, who's awake`,
        mentionedUserIds: [BOT_ID, OTHER_ID],
      }),
    ).toEqual({
      content: `<@${OTHER_ID}> role call, who's awake`,
      invocation: "mention",
    });
  });

  test("routes a direct reply to Eliza without requiring another mention", () => {
    expect(turn({ content: "what about now?", repliedUserId: BOT_ID })).toEqual(
      {
        content: "what about now?",
        invocation: "reply",
      },
    );
  });

  test.each([
    { label: "mentions another user", mentionedUserIds: [OTHER_ID] },
    {
      label: "replies to another user",
      mentionedUserIds: [],
      repliedUserId: OTHER_ID,
    },
    {
      label: "mentions everyone",
      mentionedUserIds: [],
      mentionsEveryone: true,
    },
  ])(
    "ignores a message that only $label",
    ({ label: _label, ...targeting }) => {
      expect(turn(targeting)).toBeNull();
    },
  );

  test.each([
    { label: "empty text", content: "" },
    {
      label: "bare mention",
      content: `<@${BOT_ID}>`,
      mentionedUserIds: [BOT_ID],
    },
  ])("ignores $label", ({ label: _label, ...message }) => {
    expect(turn(message)).toBeNull();
  });
});

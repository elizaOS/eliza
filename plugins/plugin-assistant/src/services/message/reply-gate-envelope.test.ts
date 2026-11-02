/** Personality reply gate must read the user's words, not the envelope.
 *
 * The processor passes the gate the message text it lifts on. A Discord
 * envelope prefixes the user's words ("[Discord #channel] @sender
 * (timestamp): ..."), so a leading lift phrase ("wake up") no longer sits
 * at the start of the rendered text and the anchored lift patterns miss it,
 * leaving a muted agent unliftable. The gate input must therefore be the
 * user-words text (getUserMessageText), the same text the addressing
 * helpers already use. These cases pin the wiring expression: the rendered
 * envelope text suppresses, the user-words text lifts, and ambient traffic
 * stays suppressed either way. */
import { getUserMessageText } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { decideReplyGate } from "../../features/advanced-capabilities/personality/reply-gate.ts";

const mutedSlot = { reply_gate: "never_until_lift" } as never;

function envelopeMessage(userWords: string) {
  return {
    content: {
      text: `[Discord #testagent-lounge] @somefan (2026-11-02 09:00): ${userWords}`,
      currentMessageText: userWords,
      source: "discord",
    },
    roomId: "room-1",
    entityId: "user-1",
  } as never;
}

describe("reply gate envelope", () => {
  it("lifts on a leading lift phrase carried by an envelope", () => {
    const message = envelopeMessage("wake up");
    expect(
      decideReplyGate({
        userSlot: mutedSlot,
        messageText: getUserMessageText(message),
        explicitlyAddressesAgent: false,
      }),
    ).toEqual({ allow: true, reason: "lift_signal" });
  });

  it("documents that the rendered envelope text alone misses the lift", () => {
    const message = envelopeMessage("wake up");
    expect(
      decideReplyGate({
        userSlot: mutedSlot,
        messageText: message.content.text,
        explicitlyAddressesAgent: false,
      }).allow,
    ).toBe(false);
  });

  it("keeps ambient envelope traffic suppressed", () => {
    const message = envelopeMessage("hello there");
    expect(
      decideReplyGate({
        userSlot: mutedSlot,
        messageText: getUserMessageText(message),
        explicitlyAddressesAgent: false,
      }).allow,
    ).toBe(false);
  });

  it("lifts on a mid-list lift phrase through the envelope", () => {
    const message = envelopeMessage("you can talk again");
    expect(
      decideReplyGate({
        userSlot: mutedSlot,
        messageText: getUserMessageText(message),
        explicitlyAddressesAgent: false,
      }),
    ).toEqual({ allow: true, reason: "lift_signal" });
  });
});

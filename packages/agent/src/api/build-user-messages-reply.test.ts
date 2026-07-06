/**
 * The reply-target round-trip through `buildUserMessages`: the dashboard sends
 * the replied-to message id in `metadata.replyToMessageId`; the API boundary
 * must lift it onto `content.inReplyTo` (the canonical field the REPLY_CONTEXT
 * provider and the GET /messages DTO read), validating it as a UUID so a forged
 * value can't smuggle an arbitrary string into the prompt pipeline. Deterministic
 * — calls the real exported helper; no live model, DB, or HTTP.
 */

import { ChannelType, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildUserMessages } from "./server-helpers.ts";

const USER_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const TARGET_ID = "00000000-0000-4000-8000-00000000abcd";

function base() {
  return {
    images: undefined,
    prompt: "about that earlier point",
    userId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    channelType: ChannelType.DM,
  };
}

describe("buildUserMessages reply-target lift", () => {
  it("lifts metadata.replyToMessageId onto content.inReplyTo", async () => {
    const { userMessage, messageToStore } = await buildUserMessages({
      ...base(),
      metadata: { replyToMessageId: TARGET_ID },
    });
    expect(userMessage.content.inReplyTo).toBe(TARGET_ID);
    // The persistence-safe counterpart carries it too, so a reply survives a
    // reload and the GET /messages round-trip can echo it back.
    expect(messageToStore.content.inReplyTo).toBe(TARGET_ID);
  });

  it("omits inReplyTo when no reply target is supplied", async () => {
    const { userMessage } = await buildUserMessages(base());
    expect(userMessage.content.inReplyTo).toBeUndefined();
  });

  it("rejects a non-UUID reply id rather than passing it through", async () => {
    const { userMessage } = await buildUserMessages({
      ...base(),
      metadata: { replyToMessageId: "'; DROP TABLE memories;--" },
    });
    expect(userMessage.content.inReplyTo).toBeUndefined();
  });

  it("keeps the raw metadata alongside the lifted field", async () => {
    const { userMessage } = await buildUserMessages({
      ...base(),
      metadata: { replyToMessageId: TARGET_ID, source: "upload" },
    });
    expect(userMessage.content.inReplyTo).toBe(TARGET_ID);
    expect(
      (userMessage.content.metadata as { source?: string } | undefined)?.source,
    ).toBe("upload");
  });
});

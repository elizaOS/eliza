/**
 * Reproduces chat attachment identity collisions across separate messages by
 * exercising the real upload persistence and conversation-window listing path.
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";

const previousStateDir = process.env.ELIZA_STATE_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-id-repro-"));
process.env.ELIZA_STATE_DIR = stateDir;

const { buildChatAttachments } = await import("./server-helpers.ts");
const { listConversationAttachments } = await import(
  "../../../core/src/features/working-memory/attachmentContext.ts"
);

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const roomId = "00000000-0000-0000-0000-000000000002" as UUID;
const firstMessageId = "00000000-0000-0000-0000-000000000003" as UUID;
const secondMessageId = "00000000-0000-0000-0000-000000000004" as UUID;
const viewerMessageId = "00000000-0000-0000-0000-000000000005" as UUID;

const firstUpload = await buildChatAttachments([
  {
    data: Buffer.from("first image bytes").toString("base64"),
    mimeType: "image/png",
    name: "first.png",
  },
]);
const secondUpload = await buildChatAttachments([
  {
    data: Buffer.from("second image bytes").toString("base64"),
    mimeType: "image/png",
    name: "second.png",
  },
]);

const firstAttachment = firstUpload.compactAttachments?.[0];
const secondAttachment = secondUpload.compactAttachments?.[0];

const firstMessage = {
  id: firstMessageId,
  entityId: agentId,
  agentId,
  roomId,
  createdAt: 1,
  content: { text: "first", attachments: firstUpload.compactAttachments },
} as Memory;
const secondMessage = {
  id: secondMessageId,
  entityId: agentId,
  agentId,
  roomId,
  createdAt: 2,
  content: { text: "second", attachments: secondUpload.compactAttachments },
} as Memory;
const viewerMessage = {
  id: viewerMessageId,
  entityId: agentId,
  agentId,
  roomId,
  createdAt: 3,
  content: { text: "list attachments" },
} as Memory;
const runtime = {
  agentId,
  getMemories: async () => [firstMessage, secondMessage],
} as unknown as IAgentRuntime;

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = previousStateDir;
  }
});

describe("chat attachment ids across messages", () => {
  it("mints distinct ids for uploads with distinct content addresses", () => {
    console.log(
      "first :",
      firstAttachment?.id,
      firstAttachment?.url,
      firstAttachment?.filename,
    );
    console.log(
      "second:",
      secondAttachment?.id,
      secondAttachment?.url,
      secondAttachment?.filename,
    );

    expect(firstAttachment?.id).not.toBe(secondAttachment?.id);
  });

  it("lists both uploads in the conversation window", async () => {
    const listed = await listConversationAttachments(runtime, viewerMessage);
    console.log(
      "listed:",
      listed.map(({ id, url, filename }) => ({ id, url, filename })),
    );

    expect(listed.map(({ filename }) => filename).sort()).toEqual([
      "first.png",
      "second.png",
    ]);
  });
});

/**
 * Regression coverage for `processToolResult`'s attachment ID integrity.
 * Exercises the real exported helper with a lightweight runtime stub (only
 * `agentId` is read by `createUniqueUuid`). Guards the contract that every
 * image `Media` a tool call emits gets a genuinely unique `id`: the UI treats
 * `Media.id` as a unique handle for React keys and download filenames
 * (packages/ui/src/components/chat/MessageAttachments.tsx), so colliding ids
 * produced duplicate keys and identical download names for distinct images
 * (#22511).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { processToolResult } from "../processing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const runtime = {
  agentId: "11111111-1111-1111-1111-111111111111",
} as unknown as IAgentRuntime;

const messageEntityId = "22222222-2222-2222-2222-222222222222";

function imageContent(data: string) {
  return { type: "image", mimeType: "image/png", data } as const;
}

describe("processToolResult attachment ids", () => {
  it("assigns a distinct id to each image in a multi-image tool result", () => {
    const { attachments, hasAttachments } = processToolResult(
      { content: [imageContent("AAAA"), imageContent("BBBB"), imageContent("CCCC")] },
      "img-server",
      "generate_image",
      runtime,
      messageEntityId
    );

    expect(hasAttachments).toBe(true);
    expect(attachments).toHaveLength(3);
    const ids = attachments.map((a) => a.id);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("still yields a single well-formed id for a single-image tool result", () => {
    const { attachments } = processToolResult(
      { content: [imageContent("ZZZZ")] },
      "img-server",
      "generate_image",
      runtime,
      messageEntityId
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.id).toMatch(UUID_RE);
    expect(attachments[0]?.url).toBe("data:image/png;base64,ZZZZ");
  });

  it("does not reuse an id across separate tool calls with different image bytes", () => {
    const first = processToolResult(
      { content: [imageContent("AAAA")] },
      "img-server",
      "generate_image",
      runtime,
      messageEntityId
    );
    const second = processToolResult(
      { content: [imageContent("DDDD")] },
      "img-server",
      "generate_image",
      runtime,
      messageEntityId
    );

    expect(first.attachments[0]?.id).not.toBe(second.attachments[0]?.id);
  });

  it("distinguishes two images that share identical bytes within one call", () => {
    const { attachments } = processToolResult(
      { content: [imageContent("SAME"), imageContent("SAME")] },
      "img-server",
      "generate_image",
      runtime,
      messageEntityId
    );

    expect(attachments).toHaveLength(2);
    expect(attachments[0]?.id).not.toBe(attachments[1]?.id);
  });

  it("emits no attachments and no id churn for a text-only result", () => {
    const { attachments, hasAttachments, toolOutput } = processToolResult(
      { content: [{ type: "text", text: "hello" }] },
      "img-server",
      "generate_image",
      runtime,
      messageEntityId
    );

    expect(hasAttachments).toBe(false);
    expect(attachments).toHaveLength(0);
    expect(toolOutput).toBe("hello");
  });
});

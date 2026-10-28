import { describe, expect, it } from "bun:test";
import { ContentType, type IAgentRuntime } from "@elizaos/core";
import { processToolResult } from "./processing";

const runtime = {
  agentId: "11111111-1111-4111-8111-111111111111",
} as IAgentRuntime;

describe("cloud MCP image results", () => {
  it("classifies mixed-case MIME types without rewriting attachment bytes", () => {
    const result = processToolResult(
      { content: [{ type: "image", mimeType: "IMAGE/PNG", data: "YWJj" }] },
      "server",
      "images",
      runtime,
      "owner",
    );
    expect(result.attachments[0]?.contentType).toBe(ContentType.IMAGE);
    expect(result.attachments[0]?.url).toBe("data:IMAGE/PNG;base64,YWJj");
  });

  it("retains every returned image beyond the former four-image boundary", () => {
    const content = Array.from({ length: 6 }, (_, index) => ({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(`image-${index}`).toString("base64"),
    }));
    const result = processToolResult({ content }, "server", "images", runtime, "owner");
    expect(result.hasAttachments).toBe(true);
    expect(result.attachments.map((attachment) => attachment.url)).toEqual(
      content.map((image) => `data:${image.mimeType};base64,${image.data}`),
    );
    expect(new Set(result.attachments.map((attachment) => attachment.id)).size).toBe(6);
  });
});

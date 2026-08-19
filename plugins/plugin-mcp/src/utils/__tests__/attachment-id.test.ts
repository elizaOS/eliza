import { describe, expect, it } from "vitest";
import { processToolResult } from "../processing";

const baseRuntime = {
  agentId: "test-agent",
} as any;

const baseResult = (images: { data: string; mimeType: string }[]) => ({
  content: images.map((img, i) => ({
    type: "image",
    data: img.data,
    mimeType: img.mimeType,
    text: undefined as string | undefined,
  })),
  isError: false,
});

describe("processToolResult attachment ids", () => {
  it("assigns distinct ids to multiple images in one tool result", () => {
    const { attachments } = processToolResult(
      baseResult([
        { data: "AAAA", mimeType: "image/png" },
        { data: "BBBB", mimeType: "image/png" },
        { data: "CCCC", mimeType: "image/png" },
      ]),
      "server",
      "tool",
      baseRuntime,
      "msg-1",
    );
    const ids = attachments.map((a) => a.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("yields a well-formed id for a single image", () => {
    const { attachments } = processToolResult(
      baseResult([{ data: "AAAA", mimeType: "image/png" }]),
      "server",
      "tool",
      baseRuntime,
      "msg-1",
    );
    expect(attachments[0].id).toBeTruthy();
    expect(typeof attachments[0].id).toBe("string");
  });

  it("does not reuse ids across separate calls with different image bytes", () => {
    const a = processToolResult(
      baseResult([{ data: "AAAA", mimeType: "image/png" }]),
      "server",
      "tool",
      baseRuntime,
      "msg-1",
    );
    const b = processToolResult(
      baseResult([{ data: "BBBB", mimeType: "image/png" }]),
      "server",
      "tool",
      baseRuntime,
      "msg-1",
    );
    expect(a.attachments[0].id).not.toBe(b.attachments[0].id);
  });
});

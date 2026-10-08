/**
 * A stored file just under 1 MB is still in the kilobyte branch, but one
 * decimal place rounds 1023.999 KB to "1024.0 KB". The FILES list must
 * promote that size to megabytes.
 */
import { type IAgentRuntime, ServiceType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { filesAction } from "./files.ts";

function runtimeWithSize(size: number): IAgentRuntime {
  return {
    getService(type: string) {
      if (type !== ServiceType.REMOTE_FILES) return null;
      return {
        list: async () => [
          {
            url: "/api/media/abc.txt",
            hash: "abc",
            fileName: "abc.txt",
            mimeType: "text/plain",
            size,
            createdAt: 1,
          },
        ],
      };
    },
  } as unknown as IAgentRuntime;
}

async function listText(size: number): Promise<string> {
  const handler = filesAction.handler;
  if (!handler) throw new Error("FILES handler is missing");
  const result = await handler(runtimeWithSize(size), {} as never, undefined, {
    parameters: { op: "list" },
  });
  return result?.text ?? "";
}

describe("FILES list size", () => {
  it("promotes a file one byte under 1 MB from 1024.0 KB to 1.0 MB", async () => {
    const text = await listText(1024 * 1024 - 1);
    expect(text).toContain("1.0 MB");
    expect(text).not.toContain("1024.0 KB");
  });

  it("keeps byte, kilobyte, and exact megabyte sizes", async () => {
    expect(await listText(512)).toContain("512 B");
    expect(await listText(1536)).toContain("1.5 KB");
    expect(await listText(1_048_524)).toContain("1023.9 KB");
    expect(await listText(1024 * 1024)).toContain("1.0 MB");
  });
});

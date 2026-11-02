import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/plugin-blocker/services/website-blocker/index", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@elizaos/plugin-blocker/services/website-blocker/index")
  >();
  return {
    ...actual,
    getSelfControlAccess: vi.fn(async () => ({ allowed: true, role: "OWNER" })),
  };
});

import { runWebsiteBlockHandler } from "./website-block.js";

const USER_WORDS = "Block youtube.com for 1 hour.";
const ENVELOPED =
  "Answer the user request using the contextual documents below.\n\n" +
  "Document: a note about my focus routine — I also read example.com and news.site.org every morning.\n\n" +
  `<user_request>${USER_WORDS}</user_request>`;

function makeMessage(text: string): Memory {
  return {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
}

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "agent-1",
    reportError: () => {},
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    deleteCache: async (key: string) => {
      cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

async function runHandler(text: string) {
  return runWebsiteBlockHandler(makeRuntime(), makeMessage(text), undefined, {
    parameters: { subaction: "block" },
  } as never);
}

describe("WEBSITE_BLOCK host envelope", () => {
  it("drafts a block for the requested host only", async () => {
    const result = await runHandler(USER_WORDS);
    expect(result.text).toContain("youtube.com");
    expect(result.text).toContain("60 minutes");
  });

  it("does not let a document fragment add hosts to the block draft", async () => {
    const result = await runHandler(ENVELOPED);
    expect(result.text).toContain("youtube.com");
    expect(result.text).not.toContain("example.com");
    expect(result.text).not.toContain("news.site.org");
  });
});

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  _setLinkPreviewTransportForTests,
  linkExtractionEvaluator,
} from "./link-extraction.ts";

const pages: Record<string, string> = {
  "https://blog.example.org/post":
    "<html><head><title>It&#8217;s Live &#8211; My Blog</title></head></html>",
  "https://react.example.org/":
    '<html><head><meta property="og:title" content="Don&#x27;t Panic"></head></html>',
};

describe("link preview title", () => {
  afterEach(() => _setLinkPreviewTransportForTests(undefined));

  it("decodes numeric character references in the title and og:title", async () => {
    _setLinkPreviewTransportForTests({
      fetchImpl: (async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        return new Response(pages[url], {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as typeof fetch,
    });
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      logger: { warn() {}, info() {}, debug() {} },
      reportError() {},
      useModel: async () => "",
      createMemory: async () => {},
    } as unknown as IAgentRuntime;
    const message = {
      id: "00000000-0000-0000-0000-000000000002",
      roomId: "00000000-0000-0000-0000-000000000003",
      entityId: "00000000-0000-0000-0000-000000000004",
      content: { text: Object.keys(pages).join(" "), source: "discord" },
    } as Memory;

    const prepared = (await linkExtractionEvaluator.prepare?.({
      runtime,
      message,
    } as never)) as { links: Array<{ title: string }> };

    expect(prepared.links.map((link) => link.title)).toEqual([
      "It’s Live – My Blog",
      "Don't Panic",
    ]);
  });
});

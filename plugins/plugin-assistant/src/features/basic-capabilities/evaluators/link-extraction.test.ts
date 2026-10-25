import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import {
  _setLinkPreviewTransportForTests,
  linkExtractionEvaluator,
} from "./link-extraction.ts";

const PAGES: Record<string, string> = {
  "/title": "<title>It&#x27;s &#8217;here&#146;</title>",
  "/og": '<meta property="og:title" content="It&#x27;s &#8217;here&#146;">',
};

afterEach(() => _setLinkPreviewTransportForTests(undefined));

it("decodes numeric references in <title> and og:title", async () => {
  _setLinkPreviewTransportForTests({
    lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    pinnedFetchImpl: async ({ url }) =>
      new Response(PAGES[url.pathname], {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    useModel: async () => "",
    createMemory: async () => undefined,
  } as unknown as IAgentRuntime;
  const message = {
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "https://example.com/title https://example.com/og" },
  } as Memory;

  const prepared = await linkExtractionEvaluator.prepare?.({
    runtime,
    message,
    state: {} as State,
    options: {},
  });

  expect(prepared?.links.map((link) => link.title)).toEqual([
    "It's ’here’",
    "It's ’here’",
  ]);
});

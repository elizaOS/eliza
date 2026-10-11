/**
 * RSS titles pass through NewsDataService.decodeHtmlEntities. Numeric
 * references in the C1 range must follow the WHATWG windows-1252 table
 * (the decodeBasicHtmlEntities contract): &#150; is an en dash, not the
 * invisible U+0096 control, and unassigned slots stay as written.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { NewsDataService } from "./newsDataService";

type ParseRSS = {
  parseRSS(xmlText: string): Array<{ title?: string }>;
};

async function parseTitles(
  xmlText: string,
): Promise<Array<string | undefined>> {
  const service = await NewsDataService.start({} as unknown as IAgentRuntime);
  return (service as unknown as ParseRSS)
    .parseRSS(xmlText)
    .map((item) => item.title);
}

function feedWithTitle(title: string): string {
  return `<rss><channel><item><title>${title}</title><link>https://example.com/a</link></item></channel></rss>`;
}

it("decodes C1 numeric references in RSS titles through windows-1252", async () => {
  expect(
    await parseTitles(feedWithTitle("Costs &#128;5, up &#150; down")),
  ).toEqual(["Costs €5, up – down"]);
  expect(await parseTitles(feedWithTitle("&#145;quoted&#146; &#159;"))).toEqual(
    ["‘quoted’ Ÿ"],
  );
});

it("leaves unassigned C1 slots and invalid references as written", async () => {
  expect(
    await parseTitles(feedWithTitle("a&#129;b &#141; &#157; &#0; &#55296;")),
  ).toEqual(["a&#129;b &#141; &#157; &#0; &#55296;"]);
});

it("keeps ordinary numeric and named decoding unchanged", async () => {
  expect(
    await parseTitles(
      feedWithTitle("Fish &amp; Chips &#8212; &#128512; &#65;"),
    ),
  ).toEqual(["Fish & Chips — 😀 A"]);
});

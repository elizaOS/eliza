import { afterAll, expect, mock, test } from "bun:test";

const pages = new Map<string, string>();
mock.module("../security/safe-fetch", () => ({
  safeFetch: async (url: string) =>
    new Response(pages.get(url) ?? "", { headers: { "content-type": "text/html" } }),
}));
const { appPromotionAssetsService } = await import("./app-promotion-assets");
afterAll(() => {
  mock.restore();
});

test("fetchWebsiteContext reads meta content in any attribute order and with quoted '>'", async () => {
  const fetchWebsiteContext = (
    appPromotionAssetsService as unknown as {
      fetchWebsiteContext(url: string): Promise<{ description?: string }>;
    }
  ).fetchWebsiteContext.bind(appPromotionAssetsService);
  const cases = {
    "content-first": ['<meta content="Ship faster" name="description">', "Ship faster"],
    apostrophe: [`<meta name="description" content="Eliza's agents">`, "Eliza's agents"],
    "gt-in-content": ['<meta name="description" content="Home > Products">', "Home > Products"],
    "name-first": ['<meta name="description" content="Agents -> done">', "Agents -> done"],
    "no-space": [
      '<meta data-name="description" content="Wrong"><meta name="description"content="Tight">',
      "Tight",
    ],
  };
  for (const [path, [head, expected]] of Object.entries(cases)) {
    const url = `https://93.184.215.14/${path}`;
    pages.set(url, `<html><head>${head}</head></html>`);
    expect({ path, description: (await fetchWebsiteContext(url)).description }).toEqual({
      path,
      description: expected,
    });
  }
});

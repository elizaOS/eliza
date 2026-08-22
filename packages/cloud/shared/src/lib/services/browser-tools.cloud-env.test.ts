/** Verifies hosted browser requests read request-scoped Worker bindings. */

import { afterEach, expect, mock, test } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";

mock.module("../cache/client", () => ({ cache: {} }));
mock.module("./usage", () => ({ usageService: { create: mock() } }));

const { extractHostedPage } = await import("./browser-tools");

const originalFetch = globalThis.fetch;
const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;
const originalFirecrawlUrl = process.env.FIRECRAWL_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalFirecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = originalFirecrawlKey;
  if (originalFirecrawlUrl === undefined) delete process.env.FIRECRAWL_API_URL;
  else process.env.FIRECRAWL_API_URL = originalFirecrawlUrl;
});

test("uses Firecrawl key and URL from the active Worker binding context", async () => {
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_URL;
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://firecrawl.example/v2/scrape");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer worker-secret");
    return Response.json({ success: true, data: { markdown: "Menu" } });
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const result = await runWithCloudBindings(
    {
      FIRECRAWL_API_KEY: "worker-secret",
      FIRECRAWL_API_URL: "https://firecrawl.example/",
    },
    () => extractHostedPage({ url: "https://www.doordash.com/" }),
  );

  expect(result.markdown).toBe("Menu");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

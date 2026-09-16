/** Verifies hosted browser requests read request-scoped Worker bindings. */

import { afterEach, expect, mock, test } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";

const cacheClientActualModule = await import("../cache/client");

mock.module("../cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
}));
mock.module("./usage", () => ({ usageService: { create: mock() } }));
const runFlatProviderOperation = mock(
  async (_context: unknown, _operation: unknown, dispatch: () => Promise<unknown>) => dispatch(),
);
mock.module("./generative-operation", () => ({
  isGenerativeOperationAdmissionError: () => false,
  runFlatProviderOperation,
}));

const { extractHostedPage } = await import("./browser-tools");

const originalFetch = globalThis.fetch;
const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;
const originalFirecrawlUrl = process.env.FIRECRAWL_API_URL;
const operationContext = {
  organizationId: "org-1",
  userId: "user-1",
  apiKeyId: "key-1",
  requestId: "request-1",
};

afterEach(() => {
  runFlatProviderOperation.mockClear();
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
    () =>
      extractHostedPage(
        { url: "https://www.doordash.com/" },
        {
          organizationId: "org-1",
          userId: "user-1",
          apiKeyId: "key-1",
          operationContext,
        },
      ),
  );

  expect(result.markdown).toBe("Menu");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(runFlatProviderOperation).toHaveBeenCalledTimes(1);
  expect(runFlatProviderOperation.mock.calls[0]?.[1]).toMatchObject({
    operation: "extract_page",
    provider: "firecrawl",
  });
});

test("fails closed before Firecrawl when standing context is absent", async () => {
  const fetchMock = mock(async () => Response.json({ success: true }));
  globalThis.fetch = fetchMock as typeof fetch;

  await expect(
    extractHostedPage(
      { url: "https://example.com" },
      { organizationId: "org-1", userId: "user-1" },
    ),
  ).rejects.toThrow("account-standing context");

  expect(runFlatProviderOperation).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

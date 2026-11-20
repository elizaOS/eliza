import { afterEach, expect, spyOn, test } from "bun:test";
import { linkedinAdsProvider } from "./linkedin";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const ACCOUNTS = Array.from({ length: 150 }, (_, index) => ({
  id: `50${String(index).padStart(5, "0")}`,
  name: `Account ${index}`,
}));

/** LinkedIn caps a collection page at 100 elements whatever pageSize asks for. */
function cappedPage(start: number, requested: number): unknown {
  const size = Math.min(requested, 100);
  return {
    elements: ACCOUNTS.slice(start, start + size),
    paging: { start, count: Math.min(size, Math.max(0, ACCOUNTS.length - start)) },
    metadata: { nextPageToken: start + size < ACCOUNTS.length ? `token-${start + size}` : null },
  };
}

function stubPages(onRequest: (start: number, requested: number) => unknown): void {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const requested = Number(url.searchParams.get("pageSize") ?? "0");
      const start = Number(url.searchParams.get("start") ?? "0");
      return Response.json(onRequest(start, requested));
    }),
  );
}

test("returns every active ad account when LinkedIn caps the collection page", async () => {
  stubPages((start, requested) => cappedPage(start, requested));

  const accounts = await linkedinAdsProvider.listAdAccounts({ accessToken: "fixture-token" });

  expect(accounts.map((account) => account.id)).toEqual(ACCOUNTS.map((account) => account.id));
});

test("fails closed when the provider keeps returning the same page", async () => {
  stubPages((_start, requested) => cappedPage(0, requested));

  await expect(
    linkedinAdsProvider.listAdAccounts({ accessToken: "fixture-token" }),
  ).rejects.toThrow(/ad account/i);
});

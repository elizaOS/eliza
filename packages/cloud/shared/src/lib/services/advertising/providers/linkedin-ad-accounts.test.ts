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

const NEXT_PAGE_TOKEN = "provider+/cursor=&?";

function stubPages(onRequest: (pageToken: string | null) => unknown): void {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.has("start")).toBe(false);
      return Response.json(onRequest(url.searchParams.get("pageToken")));
    }),
  );
}

test("returns every active ad account using the provider cursor", async () => {
  stubPages((pageToken) => {
    if (pageToken === null) {
      return { elements: ACCOUNTS.slice(0, 75), metadata: { nextPageToken: NEXT_PAGE_TOKEN } };
    }
    expect(pageToken).toBe(NEXT_PAGE_TOKEN);
    return { elements: ACCOUNTS.slice(75) };
  });

  const accounts = await linkedinAdsProvider.listAdAccounts({ accessToken: "fixture-token" });

  expect(accounts.map((account) => account.id)).toEqual(ACCOUNTS.map((account) => account.id));
});

test("fails closed when LinkedIn repeats its cursor with different accounts", async () => {
  stubPages((pageToken) => ({
    elements: pageToken === null ? ACCOUNTS.slice(0, 75) : ACCOUNTS.slice(75),
    metadata: { nextPageToken: NEXT_PAGE_TOKEN },
  }));

  await expect(
    linkedinAdsProvider.listAdAccounts({ accessToken: "fixture-token" }),
  ).rejects.toThrow(/repeated an ad account pagination cursor/i);
});

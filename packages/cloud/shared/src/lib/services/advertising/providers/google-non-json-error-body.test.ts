import { afterEach, expect, spyOn, test } from "bun:test";
import { googleAdsProvider } from "./google";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("a non-JSON error body surfaces the status with a body snippet", async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }),
  );
  const error = await googleAdsProvider
    .getCampaignMetrics({ accessToken: "fixture-token" }, "999/456")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("502");
  expect((error as Error).message).toContain("502 Bad Gateway");
});

test("a non-JSON 2xx body still throws instead of silently succeeding", async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }),
  );
  await expect(
    googleAdsProvider.getCampaignMetrics({ accessToken: "fixture-token" }, "998/456"),
  ).rejects.toThrow();
});

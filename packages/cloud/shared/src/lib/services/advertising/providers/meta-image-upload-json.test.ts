import { afterEach, expect, mock, spyOn, test } from "bun:test";

// The image path downloads through the SSRF-safe transport, which cannot be
// stubbed at fetch; stub the download itself and drive the upload POST.
mock.module("../media-utils", () => ({
  assertSafeAdMediaUrl: async (url: string) => url,
  downloadAdMedia: async (url: string) => ({
    url,
    bytes: new Uint8Array([1, 2, 3]),
    base64: Buffer.from([1, 2, 3]).toString("base64"),
    contentType: "image/png",
    fileName: "fixture.png",
  }),
  mediaFileName: () => "fixture.png",
}));

const { metaAdsProvider } = await import("./meta");

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const fixtureInput = {
  type: "image" as const,
  url: "https://example.test/fixture.png",
  name: "fixture.png",
};

test("a non-JSON image upload response surfaces the status, not a parse error", async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }),
  );
  const result = await metaAdsProvider.uploadMedia(
    { accessToken: "fixture-token" },
    "123",
    fixtureInput,
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("Meta image upload failed (502)");
});

test("a JSON image upload response still returns the image hash", async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      return Response.json({ images: { "fixture.png": { hash: "abc123" } } });
    }),
  );
  const result = await metaAdsProvider.uploadMedia(
    { accessToken: "fixture-token" },
    "123",
    fixtureInput,
  );
  expect(result.success).toBe(true);
  expect(result.providerAssetId).toBe("abc123");
});

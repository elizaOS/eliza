import fc from "fast-check";
import { describe, expect, it } from "vitest";
import worker from "./worker";

async function redirectFor(pathAndQuery: string) {
  const response = worker.fetch(
    new Request(`https://docs.elizacloud.ai${pathAndQuery}`),
  );
  return {
    status: response.status,
    location: response.headers.get("Location"),
  };
}

describe("docs elizacloud redirect worker", () => {
  it("redirects the legacy root to the cloud docs root", async () => {
    await expect(redirectFor("/")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud",
    });
  });

  it("strips the legacy /docs prefix", async () => {
    await expect(redirectFor("/docs")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud",
    });
    await expect(redirectFor("/docs?from=legacy")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud?from=legacy",
    });
    await expect(redirectFor("/docs/api/agents")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud/api/agents",
    });
  });

  it("does not strip lookalike path prefixes", async () => {
    await expect(redirectFor("/docs-old/api")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud/docs-old/api",
    });
    await expect(redirectFor("/docs2")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud/docs2",
    });
  });

  it("preserves non-doc paths and query strings", async () => {
    await expect(redirectFor("/quickstart?tab=cli&ref=old")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud/quickstart?tab=cli&ref=old",
    });
    await expect(
      redirectFor("/api/agents%20new?next=%2Fcloud%2Fbilling"),
    ).resolves.toEqual({
      status: 301,
      location:
        "https://docs.elizaos.ai/cloud/api/agents%20new?next=%2Fcloud%2Fbilling",
    });
  });

  it("normalizes duplicate slashes before applying prefix handling", async () => {
    await expect(redirectFor("//docs//api///agents?x=1")).resolves.toEqual({
      status: 301,
      location: "https://docs.elizaos.ai/cloud/api/agents?x=1",
    });
  });

  it("fuzzes hostile paths without escaping the cloud docs origin", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 96 }),
        fc.string({ maxLength: 96 }),
        (pathFragment, queryFragment) => {
          const requestUrl = new URL("https://docs.elizacloud.ai/");
          requestUrl.pathname = pathFragment;
          requestUrl.search = queryFragment ? `?q=${queryFragment}` : "";

          const response = worker.fetch(new Request(requestUrl));
          const location = response.headers.get("Location");

          expect(response.status).toBe(301);
          expect(location).not.toBeNull();
          const redirected = new URL(location ?? "");
          expect(redirected.origin).toBe("https://docs.elizaos.ai");
          expect(redirected.pathname).toMatch(/^\/cloud(?:\/|$)/);
        },
      ),
      { numRuns: 300 },
    );
  });
});

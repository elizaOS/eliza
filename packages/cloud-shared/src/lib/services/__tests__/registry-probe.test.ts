/**
 * Covers registry-probe.resolveImageDigest — the read side of fleet upgrade.
 * Mocks fetch (the only system boundary) and clears the in-memory cache
 * between tests so caching behavior is exercised explicitly, not implicitly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearRegistryProbeCache,
  parseImageRef,
  resolveImageDigest,
} from "../containers/registry-probe";

const DIGEST = "sha256:abc1234567890";

function makeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, factory] of Object.entries(routes)) {
      if (url.includes(pattern)) return factory();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function tokenResp(token = "anon-token"): Response {
  return new Response(JSON.stringify({ token }), { status: 200 });
}

function manifestResp(digest: string | null, status = 200): Response {
  const headers = new Headers();
  if (digest !== null) headers.set("docker-content-digest", digest);
  return new Response(null, { status, headers });
}

describe("parseImageRef", () => {
  test("parses a full ghcr.io reference", () => {
    expect(parseImageRef("ghcr.io/elizaos/eliza:develop")).toEqual({
      registry: "ghcr.io",
      repo: "elizaos/eliza",
      tag: "develop",
    });
  });

  test("parses a nested repo path", () => {
    expect(parseImageRef("ghcr.io/org/group/repo:v1.2.3")).toEqual({
      registry: "ghcr.io",
      repo: "org/group/repo",
      tag: "v1.2.3",
    });
  });

  test("returns null for bare image without registry", () => {
    expect(parseImageRef("eliza-agent:prod-good")).toBeNull();
  });

  test("returns null when no tag", () => {
    expect(parseImageRef("ghcr.io/elizaos/eliza")).toBeNull();
  });

  test("returns null when empty tag", () => {
    expect(parseImageRef("ghcr.io/elizaos/eliza:")).toBeNull();
  });

  test("handles port in registry (colon before slash is not a tag)", () => {
    // localhost:5000/repo:tag — last colon is the tag separator
    expect(parseImageRef("localhost:5000/repo:tag")).toEqual({
      registry: "localhost:5000",
      repo: "repo",
      tag: "tag",
    });
  });

  test("returns null for malformed input", () => {
    expect(parseImageRef("")).toBeNull();
    expect(parseImageRef(":tag")).toBeNull();
    expect(parseImageRef("noslash:tag")).toBeNull();
  });
});

describe("resolveImageDigest", () => {
  beforeEach(() => clearRegistryProbeCache());
  afterEach(() => clearRegistryProbeCache());

  test("resolves ghcr.io reference to the manifest digest", async () => {
    const fetchFn = makeFetch({
      "ghcr.io/token": () => tokenResp(),
      "manifests/develop": () => manifestResp(DIGEST),
    });
    const result = await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
    });
    expect(result).toBe(DIGEST);
  });

  test("returns null for non-ghcr registries (only ghcr supported in MVP)", async () => {
    const fetchFn = makeFetch({
      // Should not be called; resolver short-circuits before any network.
      docker: () => {
        throw new Error("docker.io should never be reached");
      },
    });
    expect(await resolveImageDigest("docker.io/library/alpine:latest", { fetchFn })).toBeNull();
  });

  test("returns null for bare image names (no registry)", async () => {
    const fetchFn = makeFetch({});
    expect(await resolveImageDigest("eliza-agent:prod-good", { fetchFn })).toBeNull();
  });

  test("returns null on 404 manifest (tag never pushed)", async () => {
    const fetchFn = makeFetch({
      "ghcr.io/token": () => tokenResp(),
      "manifests/never-pushed": () => manifestResp(null, 404),
    });
    expect(
      await resolveImageDigest("ghcr.io/elizaos/eliza:never-pushed", {
        fetchFn,
      }),
    ).toBeNull();
  });

  test("returns null on 5xx (transient registry failure)", async () => {
    const fetchFn = makeFetch({
      "ghcr.io/token": () => tokenResp(),
      manifests: () => manifestResp(null, 502),
    });
    expect(await resolveImageDigest("ghcr.io/elizaos/eliza:develop", { fetchFn })).toBeNull();
  });

  test("returns null on token endpoint failure", async () => {
    const fetchFn = makeFetch({
      "ghcr.io/token": () => new Response("forbidden", { status: 403 }),
    });
    expect(await resolveImageDigest("ghcr.io/elizaos/eliza:develop", { fetchFn })).toBeNull();
  });

  test("returns null on network error", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await resolveImageDigest("ghcr.io/elizaos/eliza:develop", { fetchFn })).toBeNull();
  });

  test("caches successful results for 60s", async () => {
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ghcr.io/token")) return tokenResp();
      return manifestResp(DIGEST);
    }) as typeof fetch;

    const t0 = 1_000_000;
    await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now: () => t0,
    });
    // Within TTL — no extra network calls.
    await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now: () => t0 + 30_000,
    });
    expect(calls).toBe(2); // 1 token + 1 manifest, no second round
  });

  test("re-fetches after TTL expiry", async () => {
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ghcr.io/token")) return tokenResp();
      return manifestResp(DIGEST);
    }) as typeof fetch;

    const t0 = 1_000_000;
    await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now: () => t0,
    });
    await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now: () => t0 + 61_000, // past 60s TTL
    });
    expect(calls).toBe(4); // 2 token + 2 manifest
  });

  test("URL-encodes tag with special characters", async () => {
    const seenUrls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      if (url.includes("ghcr.io/token")) return tokenResp();
      return manifestResp(DIGEST);
    }) as typeof fetch;

    await resolveImageDigest("ghcr.io/elizaos/eliza:develop+latest", {
      fetchFn,
    });
    const manifestUrl = seenUrls.find((u) => u.includes("/manifests/"));
    // `+` must be percent-encoded (`%2B`) so the registry sees the literal tag.
    expect(manifestUrl).toBe("https://ghcr.io/v2/elizaos/eliza/manifests/develop%2Blatest");
  });

  test("preserves `/` between repo segments while encoding each segment", async () => {
    const seenUrls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      if (url.includes("ghcr.io/token")) return tokenResp();
      return manifestResp(DIGEST);
    }) as typeof fetch;

    await resolveImageDigest("ghcr.io/org/sub/repo:v1", { fetchFn });
    const manifestUrl = seenUrls.find((u) => u.includes("/manifests/"));
    // Slashes between path segments are preserved (not `%2F`).
    expect(manifestUrl).toBe("https://ghcr.io/v2/org/sub/repo/manifests/v1");
  });

  test("caches negative results too (don't hammer ghcr on 404)", async () => {
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ghcr.io/token")) return tokenResp();
      return manifestResp(null, 404);
    }) as typeof fetch;

    const t0 = 1_000_000;
    const a = await resolveImageDigest("ghcr.io/elizaos/eliza:gone", {
      fetchFn,
      now: () => t0,
    });
    const b = await resolveImageDigest("ghcr.io/elizaos/eliza:gone", {
      fetchFn,
      now: () => t0 + 30_000,
    });
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(calls).toBe(2); // not 4 — second call hits cache
  });
});

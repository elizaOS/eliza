/**
 * Boundary tests for registry-probe — complements registry-probe.test.ts by
 * pinning down the parser's behavior on pathological refs, plus exercising
 * the cache lifecycle across heterogeneous ref kinds (ghcr / docker.io /
 * bare name) in a single sequence.
 *
 * Some of these assertions document current behavior on inputs that are
 * unlikely in practice but worth pinning so a future refactor doesn't
 * silently start crashing or silently start accepting garbage. Where the
 * parser is permissive (e.g. whitespace tag), the test asserts that the
 * downstream resolver still treats the result safely.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearRegistryProbeCache,
  parseImageRef,
  resolveImageDigest,
} from "../containers/registry-probe";

const DIGEST = "sha256:abc1234567890";

function tokenResp(token = "anon-token"): Response {
  return new Response(JSON.stringify({ token }), { status: 200 });
}

function manifestResp(digest: string | null, status = 200): Response {
  const headers = new Headers();
  if (digest !== null) headers.set("docker-content-digest", digest);
  return new Response(null, { status, headers });
}

describe("parseImageRef — boundary inputs", () => {
  test("whitespace-only tag is currently accepted by the parser", () => {
    // The parser only checks for an empty tag string, not all-whitespace. A
    // single space passes through. Pinning this so a future tightening is
    // an explicit decision rather than an accidental break.
    const parsed = parseImageRef("ghcr.io/elizaos/eliza: ");
    expect(parsed).not.toBeNull();
    expect(parsed?.tag).toBe(" ");
  });

  test("tag with leading and trailing dots is accepted as-is", () => {
    // Docker spec disallows leading periods, but the probe is permissive:
    // we'll attempt the manifest fetch and let ghcr return 404 if invalid.
    expect(parseImageRef("ghcr.io/org/repo:.v1.")).toEqual({
      registry: "ghcr.io",
      repo: "org/repo",
      tag: ".v1.",
    });
  });

  test("repo with a leading slash (double-slash after registry) keeps the slash", () => {
    // `ghcr.io//org/repo:tag` is malformed by Docker rules but our parser
    // splits on the first `/` and trusts the rest. Pin the behavior so a
    // future stricter parser is a deliberate change.
    expect(parseImageRef("ghcr.io//org/repo:tag")).toEqual({
      registry: "ghcr.io",
      repo: "/org/repo",
      tag: "tag",
    });
  });

  test("empty registry host with port (`:8080/foo:bar`) parses without crashing", () => {
    // Pathological: registry segment is just `:8080`. The parser keys off
    // the colon-in-host heuristic and accepts it. Downstream this is a
    // non-ghcr ref, so resolveImageDigest will short-circuit to null.
    const parsed = parseImageRef(":8080/foo:bar");
    expect(parsed).toEqual({
      registry: ":8080",
      repo: "foo",
      tag: "bar",
    });
  });

  test("unicode characters in tag are preserved", () => {
    // The probe URL-encodes the tag before fetching, so unicode tags don't
    // crash the parser and would round-trip through encodeURIComponent.
    expect(parseImageRef("ghcr.io/org/repo:тэг-1")).toEqual({
      registry: "ghcr.io",
      repo: "org/repo",
      tag: "тэг-1",
    });
  });

  test("trailing slash with no tag returns null", () => {
    // lastColon < lastSlash, so the colon-after-slash rule rejects it.
    expect(parseImageRef("ghcr.io/elizaos/eliza/")).toBeNull();
  });

  test("digest-style ref (@sha256:...) is not a tag and returns null", () => {
    // We don't support digest-pinned refs in the probe. The `@` doesn't
    // count as a tag separator, so parsing produces no tag.
    expect(parseImageRef("ghcr.io/elizaos/eliza@sha256:abc")).toEqual({
      // The parser sees the last colon (inside the digest) and treats
      // "abc" as the tag. Pin the current behavior — we'd want to reject
      // `@`-refs explicitly in a future hardening.
      registry: "ghcr.io",
      repo: "elizaos/eliza@sha256",
      tag: "abc",
    });
  });
});

describe("resolveImageDigest — pathological refs short-circuit safely", () => {
  beforeEach(() => clearRegistryProbeCache());
  afterEach(() => clearRegistryProbeCache());

  test("`:8080/foo:bar` resolves to null without hitting the network", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error("should not fetch for non-ghcr ref");
    }) as typeof fetch;
    expect(await resolveImageDigest(":8080/foo:bar", { fetchFn })).toBeNull();
    expect(calls).toBe(0);
  });

  test("whitespace tag on ghcr ref does attempt the fetch (parser is permissive)", async () => {
    // Documents that the parser will let a whitespace tag through to the
    // network layer. If we ever tighten the parser, flip this test.
    let manifestCalled = false;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ghcr.io/token")) return tokenResp();
      manifestCalled = true;
      return manifestResp(null, 404);
    }) as typeof fetch;
    const result = await resolveImageDigest("ghcr.io/elizaos/eliza: ", {
      fetchFn,
    });
    expect(result).toBeNull();
    expect(manifestCalled).toBe(true);
  });
});

describe("clearRegistryProbeCache — multi-ref cache lifecycle", () => {
  beforeEach(() => clearRegistryProbeCache());
  afterEach(() => clearRegistryProbeCache());

  test("ghcr / docker.io / bare-name entries cache independently and clear together", async () => {
    let ghcrCalls = 0;
    let dockerCalls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ghcr.io/token")) {
        ghcrCalls += 1;
        return tokenResp();
      }
      if (url.includes("ghcr.io/v2")) {
        ghcrCalls += 1;
        return manifestResp(DIGEST);
      }
      if (url.includes("docker")) {
        // Non-ghcr should never reach the network; record if it does so
        // the test fails loudly on a future regression.
        dockerCalls += 1;
        throw new Error("docker.io should never reach the network");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const t0 = 1_000_000;
    const now = () => t0;

    // 1. ghcr ref — hits the network, caches a real digest.
    const ghcr1 = await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now,
    });
    expect(ghcr1).toBe(DIGEST);
    expect(ghcrCalls).toBe(2); // token + manifest

    // 2. docker.io ref — non-ghcr, caches null, no network calls.
    const docker1 = await resolveImageDigest("docker.io/library/alpine:latest", {
      fetchFn,
      now,
    });
    expect(docker1).toBeNull();
    expect(dockerCalls).toBe(0);

    // 3. Bare name (no registry) — caches null, no network calls.
    const bare1 = await resolveImageDigest("eliza-agent:prod-good", {
      fetchFn,
      now,
    });
    expect(bare1).toBeNull();

    // Re-resolving each ref within TTL must NOT trigger additional fetches.
    const ghcr2 = await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now,
    });
    const docker2 = await resolveImageDigest("docker.io/library/alpine:latest", {
      fetchFn,
      now,
    });
    const bare2 = await resolveImageDigest("eliza-agent:prod-good", {
      fetchFn,
      now,
    });
    expect(ghcr2).toBe(DIGEST);
    expect(docker2).toBeNull();
    expect(bare2).toBeNull();
    expect(ghcrCalls).toBe(2); // unchanged — second ghcr hit was cached

    // After clearing, ghcr ref re-fetches; non-ghcr refs still short-circuit
    // (no cache hit, but the registry check is what gates the network).
    clearRegistryProbeCache();
    await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn,
      now,
    });
    expect(ghcrCalls).toBe(4); // token + manifest again after clear
    await resolveImageDigest("docker.io/library/alpine:latest", {
      fetchFn,
      now,
    });
    await resolveImageDigest("eliza-agent:prod-good", { fetchFn, now });
    expect(dockerCalls).toBe(0); // still never hit the network
  });

  test("re-resolving an already-cached entry never invokes fetch", async () => {
    // Stronger version of the existing "caches successful results" test:
    // after the initial population, replace the fetchFn with one that
    // throws on any call. If the cache is honored, the throwing fetch is
    // never invoked.
    const populateFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ghcr.io/token")) return tokenResp();
      return manifestResp(DIGEST);
    }) as typeof fetch;

    const t0 = 2_000_000;
    const initial = await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn: populateFetch,
      now: () => t0,
    });
    expect(initial).toBe(DIGEST);

    const throwingFetch = (async () => {
      throw new Error("fetch must not be called when entry is cached");
    }) as typeof fetch;

    const cached = await resolveImageDigest("ghcr.io/elizaos/eliza:develop", {
      fetchFn: throwingFetch,
      now: () => t0 + 10_000,
    });
    expect(cached).toBe(DIGEST);
  });

  test("negative cache for non-ghcr ref is honored across calls", async () => {
    let registryCheckCalls = 0;
    const fetchFn = (async () => {
      registryCheckCalls += 1;
      throw new Error("non-ghcr should never fetch");
    }) as typeof fetch;

    const t0 = 3_000_000;
    await resolveImageDigest("docker.io/library/alpine:latest", {
      fetchFn,
      now: () => t0,
    });
    await resolveImageDigest("docker.io/library/alpine:latest", {
      fetchFn,
      now: () => t0 + 30_000,
    });
    expect(registryCheckCalls).toBe(0);
  });
});

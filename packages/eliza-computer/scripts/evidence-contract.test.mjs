/**
 * Exercises the evidence boundary with deterministic response objects before
 * the production recorder is allowed to touch the real eliza.army apex.
 */

import { describe, expect, it, vi } from "vitest";
import {
  assertCommittedBuildManifest,
  assertDnsAddresses,
  assertHttpsRedirect,
  assertImmutableAssetCache,
  assertLiveLedgerReady,
  assertSecurityHeaders,
  assertTlsSession,
  PRODUCTION_ORIGIN,
  parseEvidenceMode,
  shouldBuildForEvidence,
  verifyRemoteArtifacts,
} from "./evidence-contract.mjs";

const now = Date.parse("2026-07-30T20:00:00.000Z");

function liveLedger(overrides = {}) {
  return {
    schemaVersion: "1",
    repository: "elizaOS/eliza",
    generatedAt: "2026-07-30T19:58:00.000Z",
    stale: false,
    source: {
      provider: "github-graphql",
      fetchedAt: "2026-07-30T19:57:59.000Z",
      requestCount: 7,
      counts: {
        mergedPullRequests: 12,
        openIssues: 34,
        openPullRequests: 5,
      },
    },
    leaders: [{ rank: 1 }],
    ledger: [{ id: "event" }],
    workQueue: {
      issues: [{ number: 1 }],
      pullRequests: [{ number: 2 }],
    },
    ...overrides,
  };
}

function securityHeaders() {
  return new Headers({
    "Content-Security-Policy":
      "default-src 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
  });
}

describe("evidence mode", () => {
  it("accepts only explicit local and production modes", () => {
    expect(parseEvidenceMode([])).toBe("local");
    expect(parseEvidenceMode(["--local"])).toBe("local");
    expect(parseEvidenceMode(["--production"])).toBe("production");
    expect(() => parseEvidenceMode(["--production", "--local"])).toThrow(
      "exactly one mode",
    );
    expect(() => parseEvidenceMode(["--url=https://example.com"])).toThrow(
      "exactly one mode",
    );
    expect(shouldBuildForEvidence("local")).toBe(true);
    expect(shouldBuildForEvidence("production")).toBe(false);
    expect(() => shouldBuildForEvidence("preview")).toThrow(
      "unknown evidence mode",
    );
  });
});

describe("live ledger readiness", () => {
  it("accepts a recent, non-empty GraphQL snapshot", () => {
    expect(assertLiveLedgerReady(liveLedger(), { now })).toMatchObject({
      ledgerCount: 1,
      leaderCount: 1,
      openIssues: 34,
      openPullRequests: 5,
      requestCount: 7,
    });
  });

  it("rejects stale, empty, and non-live snapshots", () => {
    expect(() =>
      assertLiveLedgerReady(
        liveLedger({ generatedAt: "2026-07-30T11:00:00.000Z" }),
        { now },
      ),
    ).toThrow("older than 8 hours");
    expect(() =>
      assertLiveLedgerReady(liveLedger({ ledger: [] }), { now }),
    ).toThrow("leaderboard.ledger must be a non-empty array");
    expect(() =>
      assertLiveLedgerReady(
        liveLedger({
          source: {
            ...liveLedger().source,
            provider: "fixture",
          },
        }),
        { now },
      ),
    ).toThrow("must be github-graphql");
  });

  it("rejects malformed JSON instead of substituting an empty result", () => {
    expect(() => assertLiveLedgerReady("{", { now })).toThrow(
      "must contain valid JSON",
    );
  });
});

describe("production artifact and network contract", () => {
  it("binds the manifest to a committed full revision", () => {
    const revision = "a".repeat(40);
    expect(
      assertCommittedBuildManifest(
        {
          schemaVersion: "1",
          repository: "elizaOS/eliza",
          revision,
          revisionStatus: "committed",
        },
        revision,
      ),
    ).toMatchObject({ revision, revisionStatus: "committed" });
    expect(() =>
      assertCommittedBuildManifest(
        {
          schemaVersion: "1",
          repository: "elizaOS/eliza",
          revision,
          revisionStatus: "working-tree",
        },
        revision,
      ),
    ).toThrow("must be committed");
    expect(() =>
      assertCommittedBuildManifest(
        {
          schemaVersion: "1",
          repository: "elizaOS/eliza",
          revision,
          revisionStatus: "committed",
        },
        "b".repeat(40),
      ),
    ).toThrow("does not match");
  });

  it("requires the HTTPS security policy and same-apex upgrade redirect", () => {
    expect(assertSecurityHeaders(securityHeaders())).toMatchObject({
      "x-content-type-options": "nosniff",
    });
    const redirect = assertHttpsRedirect(
      301,
      "https://eliza.army/?verify=revision",
    );
    expect(redirect.location).toBe("https://eliza.army/?verify=revision");
    expect(() => assertHttpsRedirect(302, "https://attacker.example/")).toThrow(
      `outside ${PRODUCTION_ORIGIN}`,
    );
    const missing = securityHeaders();
    missing.delete("content-security-policy");
    expect(() => assertSecurityHeaders(missing)).toThrow(
      "omitted content-security-policy",
    );
    expect(
      assertImmutableAssetCache(
        new Headers({
          "Cache-Control": "public, max-age=31536000, immutable",
        }),
      ),
    ).toContain("immutable");
    expect(() =>
      assertImmutableAssetCache(
        new Headers({ "Cache-Control": "public, max-age=300" }),
      ),
    ).toThrow("omitted max-age=31536000");
  });

  it("requires valid DNS addresses and an authorized modern TLS session", () => {
    expect(
      assertDnsAddresses([
        { address: "104.21.12.34", family: 4 },
        { address: "2606:4700:3030::6815:c22", family: 6 },
      ]),
    ).toHaveLength(2);
    expect(() =>
      assertDnsAddresses([{ address: "not-an-address", family: 4 }]),
    ).toThrow("valid A/AAAA");

    expect(
      assertTlsSession(
        {
          authorized: true,
          cipher: "TLS_AES_256_GCM_SHA384",
          protocol: "TLSv1.3",
          validTo: "2026-08-30T20:00:00.000Z",
        },
        now,
      ),
    ).toMatchObject({ authorized: true, protocol: "TLSv1.3" });
    expect(() =>
      assertTlsSession(
        {
          authorized: false,
          cipher: "TLS_AES_256_GCM_SHA384",
          protocol: "TLSv1.3",
          validTo: "2026-08-30T20:00:00.000Z",
        },
        now,
      ),
    ).toThrow("not authorized");
  });

  it("uses no-cache requests and byte-compares production artifacts", async () => {
    const contents = Buffer.from("verified index\n");
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBeInstanceOf(URL);
      expect(url.origin).toBe(PRODUCTION_ORIGIN);
      expect(url.searchParams.get("verify")).toBe("revision");
      expect(init).toMatchObject({
        cache: "no-store",
        redirect: "error",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(contents, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });

    await expect(
      verifyRemoteArtifacts({
        artifacts: [{ contents, path: "index.html" }],
        cacheKey: "revision",
        fetchImpl,
      }),
    ).resolves.toMatchObject([
      {
        bytes: contents.length,
        path: "index.html",
        status: 200,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();

    await expect(
      verifyRemoteArtifacts({
        artifacts: [{ contents, path: "index.html" }],
        cacheKey: "revision",
        fetchImpl: async () => new Response("different", { status: 200 }),
      }),
    ).rejects.toThrow("does not match");
  });
});

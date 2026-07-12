import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDomainEvidence,
  normalizeForgejoRootUrl,
} from "../src/domain-evidence.js";

describe("domain evidence", () => {
  it("builds production-gate domain evidence from a canonical HTTPS probe", async () => {
    const evidence = await buildDomainEvidence({
      forgejoRootUrl: "https://git.eliza.example",
      reverseProxyReviewed: true,
      now: new Date("2026-07-06T00:00:00.000Z"),
      fetchImpl: async () => ({
        status: 200,
        url: "https://git.eliza.example/",
      }),
    });

    assert.equal(evidence.status, "ready");
    assert.equal(evidence.checkedAt, "2026-07-06T00:00:00.000Z");
    assert.deepEqual(evidence.domain, {
      forgejoRootUrl: "https://git.eliza.example/",
      forgejoDomain: "git.eliza.example",
      tlsVerified: true,
      rootUrlCanonical: true,
      reverseProxyReviewed: true,
    });
    assert.ok(evidence.checks.every((check) => check.ok));
  });

  it("keeps the generated block review-required until reverse proxy routing is reviewed", async () => {
    const evidence = await buildDomainEvidence({
      forgejoRootUrl: "https://git.eliza.example/",
      fetchImpl: async () => ({
        status: 200,
        url: "https://git.eliza.example/",
      }),
    });

    assert.equal(evidence.status, "review_required");
    assert.equal(evidence.domain.reverseProxyReviewed, false);
    assert.equal(
      evidence.checks.find((check) => check.name === "reverse_proxy_reviewed")
        .ok,
      false,
    );
  });

  it("blocks evidence when TLS probing or canonical URL checks fail", async () => {
    const evidence = await buildDomainEvidence({
      forgejoRootUrl: "https://git.eliza.example/",
      forgejoDomain: "git.eliza.example",
      reverseProxyReviewed: true,
      fetchImpl: async () => ({
        status: 200,
        url: "https://login.eliza.example/",
      }),
    });

    assert.equal(evidence.status, "blocked");
    assert.equal(evidence.domain.tlsVerified, true);
    assert.equal(evidence.domain.rootUrlCanonical, false);
    assert.equal(
      evidence.checks.find((check) => check.name === "canonical_root_url").ok,
      false,
    );
  });

  it("blocks evidence when the canonical HTTPS root returns a non-OK status", async () => {
    const evidence = await buildDomainEvidence({
      forgejoRootUrl: "https://git.eliza.example/",
      forgejoDomain: "git.eliza.example",
      reverseProxyReviewed: true,
      fetchImpl: async () => ({
        status: 500,
        ok: false,
        url: "https://git.eliza.example/",
      }),
    });

    assert.equal(evidence.status, "blocked");
    assert.equal(evidence.probe.statusCode, 500);
    assert.equal(evidence.probe.error, "http_status_500");
    assert.equal(evidence.domain.tlsVerified, false);
    assert.equal(evidence.domain.rootUrlCanonical, false);
    assert.equal(
      evidence.checks.find((check) => check.name === "tls_fetch").ok,
      false,
    );
  });

  it("normalizes root URLs for production evidence", () => {
    assert.equal(
      normalizeForgejoRootUrl("https://git.eliza.example/forgejo").href,
      "https://git.eliza.example/forgejo/",
    );
    assert.throws(() => normalizeForgejoRootUrl(""), /forgejoRootUrl/);
  });
});

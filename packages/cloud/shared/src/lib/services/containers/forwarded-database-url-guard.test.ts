/**
 * SECURITY (H4, #12882): the container-control-plane sidecar honors a forwarded
 * `x-eliza-cloud-database-url` header and connects to it. These tests pin the
 * fail-closed guard: only the sidecar's own configured DB identity and an
 * explicit operator allowlist of full DATABASE_URLs are trusted. The identity
 * is pinned WHOLE (scheme, credentials, host, port, database) -- so a different
 * user or database on the SAME host:port is still rejected. Every
 * attacker-controlled / off-allowlist / malformed identity is rejected. A
 * regression here re-opens the tenant/database identity spoof the finding is
 * about, so the negatives matter as much as the positives.
 */

import { describe, expect, test } from "bun:test";
import {
  buildTrustedDatabaseIdentitySet,
  databaseIdentityKey,
  evaluateForwardedDatabaseUrl,
} from "./forwarded-database-url-guard";

const CONFIGURED = "postgres://svc:pw@db.internal.example:5432/cloud";

describe("databaseIdentityKey", () => {
  test("pins scheme, credentials, host, port, and database", () => {
    expect(databaseIdentityKey(CONFIGURED)).toBe(
      "postgres://svc:pw@db.internal.example:5432/cloud",
    );
  });

  test("defaults a missing Postgres port to 5432 so the two forms match", () => {
    expect(databaseIdentityKey("postgres://u:p@host.example/db")).toBe(
      databaseIdentityKey("postgres://u:p@host.example:5432/db"),
    );
  });

  test("lowercases scheme + host but NOT credentials/database (case-sensitive)", () => {
    expect(databaseIdentityKey("POSTGRES://User:Secret@DB.Example:5432/Cloud")).toBe(
      "postgres://User:Secret@db.example:5432/Cloud",
    );
  });

  test("a different database on the same host:port produces a DIFFERENT key", () => {
    expect(databaseIdentityKey("postgres://svc:pw@db.internal.example:5432/cloud")).not.toBe(
      databaseIdentityKey("postgres://svc:pw@db.internal.example:5432/exfil"),
    );
  });

  test("a different user on the same host:port produces a DIFFERENT key", () => {
    expect(databaseIdentityKey("postgres://svc:pw@db.internal.example:5432/cloud")).not.toBe(
      databaseIdentityKey("postgres://attacker:pw@db.internal.example:5432/cloud"),
    );
  });

  test("compares the database path EXACTLY -- a trailing slash is a different database", () => {
    // pg-connection-string treats `/db` and `/db/` as different db names, so the
    // guard must NOT collapse them.
    expect(databaseIdentityKey("postgres://u:p@host.example:5432/db/")).not.toBe(
      databaseIdentityKey("postgres://u:p@host.example:5432/db"),
    );
  });

  test("returns null for a URL with DUPLICATE query keys (ambiguous pg last-wins override)", () => {
    // ?host=a&host=b and ?host=b&host=a connect to different targets; refuse to
    // canonicalize either into a stable key.
    expect(databaseIdentityKey("postgres://u:p@host.example:5432/db?host=a&host=b")).toBeNull();
  });

  test("returns null for malformed values and host-less NETWORK URLs", () => {
    expect(databaseIdentityKey("")).toBeNull();
    expect(databaseIdentityKey("   ")).toBeNull();
    expect(databaseIdentityKey("not a url")).toBeNull();
    // A host-less postgres URL is not a trustable network identity.
    expect(databaseIdentityKey("postgres:///justpath")).toBeNull();
  });

  test("keys host-less local schemes (pglite file / sqlite / file) on scheme+path", () => {
    expect(databaseIdentityKey("pglite:///tmp/eliza/cloud.db")).toBe(
      "pglite:///tmp/eliza/cloud.db",
    );
    expect(databaseIdentityKey("file:///data/db.sqlite")).toBe("file:///data/db.sqlite");
    // Path compared exactly: a trailing slash is a distinct file identity.
    expect(databaseIdentityKey("pglite:///tmp/eliza/cloud.db/")).not.toBe(
      databaseIdentityKey("pglite:///tmp/eliza/cloud.db"),
    );
  });

  test("pglite://memory keeps its host-based key (has a hostname, no default pg port)", () => {
    // Non-Postgres scheme => no port defaulting; the key is stable + matches
    // an identical forwarded pglite://memory, which is all the guard needs.
    expect(databaseIdentityKey("pglite://memory")).not.toBe(databaseIdentityKey("pglite://other"));
  });
});

describe("buildTrustedDatabaseIdentitySet", () => {
  test("includes the configured DB identity", () => {
    const set = buildTrustedDatabaseIdentitySet({
      configuredDatabaseUrl: CONFIGURED,
    });
    expect(set.has("postgres://svc:pw@db.internal.example:5432/cloud")).toBe(true);
    expect(set.size).toBe(1);
  });

  test("adds allowlist URLs on top of the configured identity", () => {
    const set = buildTrustedDatabaseIdentitySet({
      configuredDatabaseUrl: CONFIGURED,
      allowlistDatabaseUrls: ["postgres://svc:pw@replica.internal.example:6543/cloud"],
    });
    expect(set.has("postgres://svc:pw@db.internal.example:5432/cloud")).toBe(true);
    expect(set.has("postgres://svc:pw@replica.internal.example:6543/cloud")).toBe(true);
  });

  test("an unparseable configured URL does NOT silently widen the set", () => {
    const set = buildTrustedDatabaseIdentitySet({
      configuredDatabaseUrl: "garbage-not-a-url",
    });
    expect(set.size).toBe(0);
  });

  test("unparseable / bare-host allowlist entries are dropped", () => {
    const set = buildTrustedDatabaseIdentitySet({
      configuredDatabaseUrl: CONFIGURED,
      // a bare host is NOT a full identity and must not widen the set
      allowlistDatabaseUrls: ["db.internal.example", "evil host", ""],
    });
    expect(set.size).toBe(1);
    expect(set.has("postgres://svc:pw@db.internal.example:5432/cloud")).toBe(true);
  });
});

describe("evaluateForwardedDatabaseUrl -- fail closed", () => {
  test("allows the exact configured control-plane database identity", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/cloud",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(decision.allowed).toBe(true);
  });

  test("allows the configured identity written with the default port implied", () => {
    const decision = evaluateForwardedDatabaseUrl("postgres://svc:pw@db.internal.example/cloud", {
      configuredDatabaseUrl: CONFIGURED,
    });
    expect(decision.allowed).toBe(true);
  });

  test("REJECTS an attacker-controlled database host", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://attacker:pw@evil.attacker.example:5432/exfil",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("does not match the pinned");
    }
  });

  test("REJECTS a DIFFERENT DATABASE on the same host:port (the #12882 P1 gap)", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/exfil",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(decision.allowed).toBe(false);
  });

  test("REJECTS a DIFFERENT USER on the same host:port + database", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://attacker:pw@db.internal.example:5432/cloud",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(decision.allowed).toBe(false);
  });

  test("REJECTS a forwarded URL that adds pg query OVERRIDE params (?host=evil, ?user=attacker)", () => {
    // pg-connection-string honors query fields as connection overrides, so
    // trusted scheme/host/path + an evil query must NOT pass.
    const evilHost = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/cloud?host=evil.example",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(evilHost.allowed).toBe(false);
    const evilUser = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/cloud?user=attacker&password=x",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(evilUser.allowed).toBe(false);
  });

  test("ALLOWS matching benign query params (e.g. ?sslmode=require) present on both sides, order-independent", () => {
    const configured =
      "postgres://svc:pw@db.internal.example:5432/cloud?sslmode=require&application_name=eliza";
    const forwardedReordered =
      "postgres://svc:pw@db.internal.example:5432/cloud?application_name=eliza&sslmode=require";
    const decision = evaluateForwardedDatabaseUrl(forwardedReordered, {
      configuredDatabaseUrl: configured,
    });
    expect(decision.allowed).toBe(true);
  });

  test("REJECTS a forwarded URL that DROPS the configured query params", () => {
    const configured = "postgres://svc:pw@db.internal.example:5432/cloud?sslmode=require";
    const forwardedNoQuery = "postgres://svc:pw@db.internal.example:5432/cloud";
    const decision = evaluateForwardedDatabaseUrl(forwardedNoQuery, {
      configuredDatabaseUrl: configured,
    });
    expect(decision.allowed).toBe(false);
  });

  test("REJECTS a forwarded URL with duplicate query keys even if one value is the trusted one", () => {
    const configured = "postgres://svc:pw@db.internal.example:5432/cloud?sslmode=require";
    // Attacker appends a second sslmode/host to override; last-wins would apply.
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/cloud?sslmode=require&sslmode=disable",
      { configuredDatabaseUrl: configured },
    );
    expect(decision.allowed).toBe(false);
  });

  test("REJECTS a trailing-slash database-name variant (pg treats /cloud vs /cloud/ as different DBs)", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/cloud/",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(decision.allowed).toBe(false);
  });

  test("REJECTS a same-host-different-port pivot", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:6379/cloud",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(decision.allowed).toBe(false);
  });

  test("REJECTS a malformed forwarded URL", () => {
    const decision = evaluateForwardedDatabaseUrl("::::not a url::::", {
      configuredDatabaseUrl: CONFIGURED,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("malformed");
    }
  });

  test("REJECTS when no trusted identity is configured at all (fail closed, not open)", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@db.internal.example:5432/cloud",
      {},
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no trusted database identity");
    }
  });

  test("allows an explicitly allowlisted replica identity", () => {
    const decision = evaluateForwardedDatabaseUrl(
      "postgres://svc:pw@replica.internal.example:6543/cloud",
      {
        configuredDatabaseUrl: CONFIGURED,
        allowlistDatabaseUrls: ["postgres://svc:pw@replica.internal.example:6543/cloud"],
      },
    );
    expect(decision.allowed).toBe(true);
  });

  test("still rejects an off-allowlist identity when an allowlist is configured", () => {
    const decision = evaluateForwardedDatabaseUrl("postgres://svc:pw@evil.example:5432/cloud", {
      configuredDatabaseUrl: CONFIGURED,
      allowlistDatabaseUrls: ["postgres://svc:pw@replica.internal.example:6543/cloud"],
    });
    expect(decision.allowed).toBe(false);
  });

  test("ALLOWS a forwarded local file-backed PGlite URL identical to the configured one (dev/test)", () => {
    const local = "pglite:///tmp/eliza/cloud.db";
    const decision = evaluateForwardedDatabaseUrl(local, {
      configuredDatabaseUrl: local,
    });
    expect(decision.allowed).toBe(true);
  });

  test("still rejects a forwarded local PGlite file that points at a DIFFERENT path", () => {
    const decision = evaluateForwardedDatabaseUrl("pglite:///tmp/evil.db", {
      configuredDatabaseUrl: "pglite:///tmp/eliza/cloud.db",
    });
    expect(decision.allowed).toBe(false);
  });
});

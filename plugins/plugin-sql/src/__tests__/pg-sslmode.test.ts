/**
 * Unit tests for `normalizePgSslMode`: rewrites the `prefer`/`require`/
 * `verify-ca` sslmode aliases to explicit `verify-full` (pinning today's
 * pg-connection-string behavior ahead of its libpq-semantics change), while
 * leaving `uselibpqcompat=true` connection strings and other sslmode values
 * untouched. Pure string transform, no database involved.
 */
import { describe, expect, it } from "vitest";
import { normalizePgSslMode } from "../pg/sslmode";

describe("normalizePgSslMode", () => {
  it("makes pg-connection-string alias SSL modes explicit", () => {
    expect(normalizePgSslMode("postgresql://user:pass@example.com/db?sslmode=require")).toBe(
      "postgresql://user:pass@example.com/db?sslmode=verify-full"
    );
    expect(
      normalizePgSslMode(
        "postgresql://user:pass@example.com/db?connect_timeout=10&sslmode=verify-ca"
      )
    ).toBe("postgresql://user:pass@example.com/db?connect_timeout=10&sslmode=verify-full");
    expect(normalizePgSslMode("postgresql://user:pass@example.com/db?sslmode=prefer#read")).toBe(
      "postgresql://user:pass@example.com/db?sslmode=verify-full#read"
    );
  });

  it("preserves explicit libpq compatibility", () => {
    expect(
      normalizePgSslMode(
        "postgresql://user:pass@example.com/db?uselibpqcompat=true&sslmode=require"
      )
    ).toBe("postgresql://user:pass@example.com/db?uselibpqcompat=true&sslmode=require");
  });

  it("normalizes libpq-style connection strings", () => {
    expect(normalizePgSslMode("host=example.com port=5432 dbname=production sslmode=require")).toBe(
      "host=example.com port=5432 dbname=production sslmode=verify-full"
    );
  });

  it("leaves non-alias SSL modes unchanged", () => {
    expect(normalizePgSslMode("postgresql://user:pass@example.com/db?sslmode=no-verify")).toBe(
      "postgresql://user:pass@example.com/db?sslmode=no-verify"
    );
    expect(normalizePgSslMode("host=example.com port=5432 dbname=production sslmode=disable")).toBe(
      "host=example.com port=5432 dbname=production sslmode=disable"
    );
  });
});

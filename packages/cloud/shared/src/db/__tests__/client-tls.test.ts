// Exercises cloud DB client tls behavior with deterministic repository fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import {
  applyIdleSessionTimeouts,
  enforceTlsForRemote,
  shouldSkipTlsVerification,
} from "../client";

const PREV = process.env.DATABASE_SSL_NO_VERIFY;
afterEach(() => {
  if (PREV === undefined) delete process.env.DATABASE_SSL_NO_VERIFY;
  else process.env.DATABASE_SSL_NO_VERIFY = PREV;
});

describe("shouldSkipTlsVerification", () => {
  test("default (no flag, no sslmode) keeps strict verification", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db")).toBe(false);
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db?sslmode=require")).toBe(
      false,
    );
  });

  test("?sslmode=no-verify opts out of verification (e.g. Railway self-signed proxy)", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    expect(
      shouldSkipTlsVerification(
        "postgresql://u:p@switchback.proxy.rlwy.net:49295/railway?sslmode=no-verify",
      ),
    ).toBe(true);
  });

  test("DATABASE_SSL_NO_VERIFY=true opts out regardless of URL", () => {
    process.env.DATABASE_SSL_NO_VERIFY = "true";
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db")).toBe(true);
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db?sslmode=require")).toBe(
      true,
    );
  });

  test("any other DATABASE_SSL_NO_VERIFY value stays strict", () => {
    process.env.DATABASE_SSL_NO_VERIFY = "false";
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db")).toBe(false);
  });
});

// enforceTlsForRemote is the shared opt-out the runtime pool AND the standalone
// admin/eliza1 pg scripts route every Railway connection through. Pin its
// {url, ssl} contract so a regression can't silently re-break those scripts
// against the Railway self-signed public proxy.
describe("enforceTlsForRemote", () => {
  test("local connections run without TLS (ssl undefined, url untouched)", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    const url = "postgresql://u:p@127.0.0.1:5432/db";
    expect(enforceTlsForRemote(url)).toEqual({ url, ssl: undefined });
  });

  test("remote default normalizes sslmode=require and verifies the cert", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    const out = enforceTlsForRemote("postgresql://u:p@host.example.com/db");
    expect(out.url).toContain("sslmode=require");
    expect(out.ssl).toEqual({ rejectUnauthorized: true });
  });

  test("remote ?sslmode=no-verify relaxes CA verification but keeps TLS", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    const out = enforceTlsForRemote(
      "postgresql://u:p@switchback.proxy.rlwy.net:49295/railway?sslmode=no-verify",
    );
    expect(out.ssl).toEqual({ rejectUnauthorized: false });
  });

  test("DATABASE_SSL_NO_VERIFY=true relaxes verification on a bare remote URL", () => {
    process.env.DATABASE_SSL_NO_VERIFY = "true";
    const out = enforceTlsForRemote("postgresql://u:p@switchback.proxy.rlwy.net:49295/railway");
    expect(out.url).toContain("sslmode=no-verify");
    expect(out.ssl).toEqual({ rejectUnauthorized: false });
  });

  test("fails closed on a remote URL that disables TLS", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    expect(() =>
      enforceTlsForRemote("postgresql://u:p@host.example.com/db?sslmode=disable"),
    ).toThrow(/must use TLS/i);
  });
});

// applyIdleSessionTimeouts is the pg-pool `onConnect` hook remote non-Worker
// pools run on every fresh connection. pg-pool AWAITS it before handing the
// client to a waiting checkout — the previous fire-and-forget
// `pool.on("connect")` query overlapped the checkout's first query on the same
// client, which node-pg deprecates ("Calling client.query() when the client is
// already executing a query…", removed in pg@9).
describe("applyIdleSessionTimeouts", () => {
  test("issues both idle-session timeouts in a single awaited query", async () => {
    const statements: string[] = [];
    await applyIdleSessionTimeouts({
      query: async (text: string) => {
        statements.push(text);
      },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("SET idle_session_timeout = '10min'");
    expect(statements[0]).toContain("SET idle_in_transaction_session_timeout = '5min'");
  });

  test("stays a no-op when the server rejects the SET (pre-PG14)", async () => {
    // A rejecting hook would make pg-pool end the client and fail the
    // checkout, so failure tolerance is load-bearing, not defensive.
    await expect(
      applyIdleSessionTimeouts({
        query: async () => {
          throw new Error('unrecognized configuration parameter "idle_session_timeout"');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

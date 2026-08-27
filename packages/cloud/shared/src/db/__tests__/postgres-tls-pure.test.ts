import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  enforceTlsForRemote,
  isLocalTcpPostgresUrl,
  shouldSkipTlsVerification,
} from "../postgres-tls";

const previous = process.env.DATABASE_SSL_NO_VERIFY;
afterEach(() => {
  if (previous === undefined) delete process.env.DATABASE_SSL_NO_VERIFY;
  else process.env.DATABASE_SSL_NO_VERIFY = previous;
});

describe("dependency-light PostgreSQL TLS policy", () => {
  test("preserves local plaintext development connections", () => {
    const url = "postgresql://u:p@127.0.0.1:5432/db";
    expect(isLocalTcpPostgresUrl(url)).toBe(true);
    expect(enforceTlsForRemote(url)).toEqual({ url, ssl: undefined });
  });

  test("enforces strict TLS on remote connections by default", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    const result = enforceTlsForRemote("postgresql://u:p@host.example/db");
    expect(result.url).toContain("sslmode=require");
    expect(result.ssl).toEqual({ rejectUnauthorized: true });
  });

  test("keeps encryption while allowing the explicit Railway CA opt-out", () => {
    const url = "postgresql://u:p@switchback.proxy.rlwy.net:49295/db?sslmode=no-verify";
    expect(shouldSkipTlsVerification(url)).toBe(true);
    expect(enforceTlsForRemote(url).ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  test("rejects remote modes that permit plaintext", () => {
    for (const mode of ["disable", "allow"]) {
      expect(() => enforceTlsForRemote(`postgresql://u:p@host.example/db?sslmode=${mode}`)).toThrow(
        /must use TLS/i,
      );
    }
  });

  test("is re-exported by the full client without importing it", () => {
    const clientSource = readFileSync(new URL("../client.ts", import.meta.url), "utf8");
    expect(clientSource).toContain('from "./postgres-tls"');
    expect(clientSource).toContain("shouldSkipTlsVerification");
    expect(clientSource).toContain("enforceTlsForRemote");
  });
});

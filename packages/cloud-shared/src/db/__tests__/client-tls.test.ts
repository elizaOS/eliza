import { afterEach, describe, expect, test } from "bun:test";
import { shouldSkipTlsVerification } from "../client";

const PREV = process.env.DATABASE_SSL_NO_VERIFY;
afterEach(() => {
  if (PREV === undefined) delete process.env.DATABASE_SSL_NO_VERIFY;
  else process.env.DATABASE_SSL_NO_VERIFY = PREV;
});

describe("shouldSkipTlsVerification", () => {
  test("default (no flag, no sslmode) keeps strict verification", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db")).toBe(false);
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db?sslmode=require")).toBe(false);
  });

  test("?sslmode=no-verify opts out of verification (e.g. Railway self-signed proxy)", () => {
    delete process.env.DATABASE_SSL_NO_VERIFY;
    expect(
      shouldSkipTlsVerification("postgresql://u:p@switchback.proxy.rlwy.net:49295/railway?sslmode=no-verify"),
    ).toBe(true);
  });

  test("DATABASE_SSL_NO_VERIFY=true opts out regardless of URL", () => {
    process.env.DATABASE_SSL_NO_VERIFY = "true";
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db")).toBe(true);
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db?sslmode=require")).toBe(true);
  });

  test("any other DATABASE_SSL_NO_VERIFY value stays strict", () => {
    process.env.DATABASE_SSL_NO_VERIFY = "false";
    expect(shouldSkipTlsVerification("postgresql://u:p@host.example.com/db")).toBe(false);
  });
});

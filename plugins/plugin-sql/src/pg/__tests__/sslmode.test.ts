import { describe, expect, it } from "vitest";
import { normalizePgSslMode } from "./sslmode.ts";

describe("normalizePgSslMode", () => {
  it("rewrites prefer/require/verify-ca to verify-full in query strings", () => {
    expect(normalizePgSslMode("postgres://db?sslmode=prefer")).toBe(
      "postgres://db?sslmode=verify-full"
    );
    expect(normalizePgSslMode("postgres://db?sslmode=require")).toBe(
      "postgres://db?sslmode=verify-full"
    );
    expect(normalizePgSslMode("postgres://db?sslmode=verify-ca")).toBe(
      "postgres://db?sslmode=verify-full"
    );
  });

  it("leaves verify-full and disable untouched", () => {
    expect(normalizePgSslMode("postgres://db?sslmode=verify-full")).toBe(
      "postgres://db?sslmode=verify-full"
    );
    expect(normalizePgSslMode("postgres://db?sslmode=disable")).toBe(
      "postgres://db?sslmode=disable"
    );
  });

  it("honors uselibpqcompat=true escape hatch", () => {
    expect(normalizePgSslMode("postgres://db?sslmode=prefer&uselibpqcompat=true")).toBe(
      "postgres://db?sslmode=prefer&uselibpqcompat=true"
    );
  });

  it("handles empty input", () => {
    expect(normalizePgSslMode("")).toBe("");
  });
});

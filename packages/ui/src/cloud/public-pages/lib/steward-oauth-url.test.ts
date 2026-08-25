/**
 * Unit tests for steward-oauth-url: validates redirect URI format and tenant ID resolution.
 */
import { describe, expect, it } from "vitest";
import {
  buildStewardOAuthRedirectUri,
  resolveStewardOAuthTenantId,
} from "./steward-oauth-url.ts";

describe("steward-oauth-url", () => {
  it("builds canonical redirect URI appending /login to origin", () => {
    expect(buildStewardOAuthRedirectUri("https://eliza.app")).toBe(
      "https://eliza.app/login",
    );
    expect(buildStewardOAuthRedirectUri("http://localhost:5173")).toBe(
      "http://localhost:5173/login",
    );
  });

  it("resolves custom tenant ID if provided", () => {
    expect(resolveStewardOAuthTenantId("custom-tenant-123")).toBe(
      "custom-tenant-123",
    );
  });

  it("falls back to default tenant ID when tenantId is empty or undefined", () => {
    const fallback = resolveStewardOAuthTenantId(undefined);
    expect(typeof fallback).toBe("string");
    expect(fallback.length).toBeGreaterThan(0);
  });
});

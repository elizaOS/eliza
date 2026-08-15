/**
 * Deterministic contract tests cover Jupiter endpoint resolution and typed
 * transport failure without substituting a mocked wallet execution path.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUPITER_API_BASE_URL,
  fetchJupiterJson,
  resolveJupiterApiBaseUrl,
} from "./jupiter-api";

const runtimeWith = (value?: string) => ({ getSetting: () => value });

describe("Jupiter API boundary", () => {
  it("routes both Solana swap builders through the shared endpoint resolver", () => {
    const registrySource = readFileSync(new URL("../registry.ts", import.meta.url), "utf8");
    const serviceSource = readFileSync(new URL("./service.ts", import.meta.url), "utf8");

    for (const source of [registrySource, serviceSource]) {
      expect(source).toContain("resolveJupiterApiBaseUrl");
      expect(source).not.toContain("quote-api.jup.ag");
    }
  });

  it("uses the live public Swap API by default", () => {
    expect(resolveJupiterApiBaseUrl(runtimeWith())).toBe("https://lite-api.jup.ag/swap/v1");
    expect(DEFAULT_JUPITER_API_BASE_URL).not.toContain("quote-api.jup.ag");
  });

  it("uses a runtime override and removes trailing slashes", () => {
    expect(resolveJupiterApiBaseUrl(runtimeWith("https://jupiter.example/v1///"))).toBe(
      "https://jupiter.example/v1"
    );
  });

  it("rejects URL components that would corrupt the appended endpoint", () => {
    for (const value of [
      "https://user@example.test/v1",
      "https://example.test/v1?key=value",
      "https://example.test/v1#fragment",
    ]) {
      expect(() => resolveJupiterApiBaseUrl(runtimeWith(value))).toThrow(
        expect.objectContaining({ code: "JUPITER_API_BASE_URL_INVALID" })
      );
    }
  });

  it("rejects a malformed runtime override instead of falling back", () => {
    expect(() => resolveJupiterApiBaseUrl(runtimeWith("not a URL"))).toThrow(
      expect.objectContaining({ code: "JUPITER_API_BASE_URL_INVALID" })
    );
  });

  it("preserves DNS failures as a typed transport error", async () => {
    const dnsFailure = new Error("getaddrinfo ENOTFOUND quote-api.jup.ag");
    const fetchFn = (() => Promise.reject(dnsFailure)) as typeof fetch;

    await expect(
      fetchJupiterJson(fetchFn, `${DEFAULT_JUPITER_API_BASE_URL}/quote`, "quote")
    ).rejects.toEqual(
      expect.objectContaining({
        code: "JUPITER_QUOTE_TRANSPORT_FAILED",
        cause: dnsFailure,
        severity: "ephemeral",
      })
    );
  });

  it("rejects non-success HTTP responses before parsing a body", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response("unavailable", { status: 503 }))) as typeof fetch;

    await expect(
      fetchJupiterJson(fetchFn, `${DEFAULT_JUPITER_API_BASE_URL}/quote`, "quote")
    ).rejects.toEqual(
      expect.objectContaining({
        code: "JUPITER_QUOTE_HTTP_ERROR",
        severity: "ephemeral",
      })
    );
  });
});

// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noDocumentCookie: CSRF tests exercise cookie parsing in jsdom.
/**
 * Unit tests for the CSRF client helpers.
 *
 * Key invariants:
 *   - GET / HEAD / OPTIONS never attach x-milady-csrf.
 *   - POST / PUT / DELETE / PATCH attach x-milady-csrf when cookie is present.
 *   - `credentials: "include"` is always set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// We import the constant from the sessions module so the test is in sync.
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./auth/sessions";
import { fetchWithCsrf, readCsrfTokenFromCookie } from "./csrf-client";

// ── readCsrfTokenFromCookie ───────────────────────────────────────────────────

describe("readCsrfTokenFromCookie", () => {
  afterEach(() => {
    // Remove the test cookie by setting Max-Age=0.
    document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; path=/`;
  });

  it("returns null when cookie is absent", () => {
    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("returns the token value when cookie is present", () => {
    document.cookie = `${CSRF_COOKIE_NAME}=abc123def456; path=/`;
    const result = readCsrfTokenFromCookie();
    expect(result).toBe("abc123def456");
  });

  it("returns the correct value when multiple cookies are present", () => {
    document.cookie = `other=foo; path=/`;
    document.cookie = `${CSRF_COOKIE_NAME}=mytoken; path=/`;
    expect(readCsrfTokenFromCookie()).toBe("mytoken");
  });
});

// ── fetchWithCsrf ─────────────────────────────────────────────────────────────

describe("fetchWithCsrf", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Plant a CSRF cookie for mutation-method tests.
    document.cookie = `${CSRF_COOKIE_NAME}=csrf-test-value; path=/`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; path=/`;
  });

  it("always sets credentials: include", async () => {
    await fetchWithCsrf("/api/test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it.each([
    "GET",
    "HEAD",
    "OPTIONS",
  ] as const)("%s does not attach x-milady-csrf", async (method) => {
    await fetchWithCsrf("/api/test", { method });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has(CSRF_HEADER_NAME)).toBe(false);
  });

  it.each([
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
  ] as const)("%s attaches x-milady-csrf when cookie present", async (method) => {
    await fetchWithCsrf("/api/test", { method });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBe("csrf-test-value");
  });

  it("POST does not attach x-milady-csrf when cookie absent", async () => {
    // Remove the cookie.
    document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; path=/`;
    await fetchWithCsrf("/api/test", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has(CSRF_HEADER_NAME)).toBe(false);
  });

  it("defaults to GET when no method supplied", async () => {
    // No method in init — treated as GET, no CSRF.
    await fetchWithCsrf("/api/test", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has(CSRF_HEADER_NAME)).toBe(false);
    expect(init.credentials).toBe("include");
  });
});

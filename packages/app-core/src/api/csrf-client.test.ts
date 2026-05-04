// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noDocumentCookie: CSRF tests exercise cookie parsing in jsdom.
/**
 * Unit tests for the CSRF client helpers.
 *
 * Key invariants:
 *   - GET / HEAD / OPTIONS never attach x-eliza-csrf.
 *   - POST / PUT / DELETE / PATCH attach x-eliza-csrf when cookie is present.
 *   - `credentials: "include"` is always set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "../config/boot-config";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./auth/sessions";
import { fetchWithCsrf, readCsrfTokenFromCookie } from "./csrf-client";

describe("readCsrfTokenFromCookie", () => {
  afterEach(() => {
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

describe("fetchWithCsrf", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    setBootConfig(DEFAULT_BOOT_CONFIG);
    document.cookie = `${CSRF_COOKIE_NAME}=csrf-test-value; path=/`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setBootConfig(DEFAULT_BOOT_CONFIG);
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
  ] as const)("%s does not attach x-eliza-csrf", async (method) => {
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
  ] as const)("%s attaches x-eliza-csrf when cookie present", async (method) => {
    await fetchWithCsrf("/api/test", { method });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBe("csrf-test-value");
  });

  it("POST does not attach x-eliza-csrf when cookie absent", async () => {
    document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; path=/`;
    await fetchWithCsrf("/api/test", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has(CSRF_HEADER_NAME)).toBe(false);
  });

  it("defaults to GET when no method supplied", async () => {
    await fetchWithCsrf("/api/test", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has(CSRF_HEADER_NAME)).toBe(false);
    expect(init.credentials).toBe("include");
  });
});

describe("fetchWithCsrf — bearer token", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  it("attaches Authorization: Bearer when apiToken is set", async () => {
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiToken: "my-secret-token" });
    await fetchWithCsrf("/api/test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer my-secret-token");
  });

  it("does not overwrite an explicit Authorization header", async () => {
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiToken: "my-secret-token" });
    await fetchWithCsrf("/api/test", {
      headers: { Authorization: "Bearer explicit-token" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer explicit-token");
  });

  it("does not attach Authorization when apiToken is absent", async () => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
    await fetchWithCsrf("/api/test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("trims whitespace from apiToken", async () => {
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiToken: "  spaced-token  " });
    await fetchWithCsrf("/api/test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer spaced-token");
  });
});

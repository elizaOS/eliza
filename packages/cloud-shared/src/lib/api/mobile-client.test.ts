import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError, api, createAuthenticatedClient } from "./mobile-client";

const originalFetch = globalThis.fetch;

describe("MobileApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    api.setBaseUrl("http://localhost:3000");
  });

  test("preserves canonical API error codes from JSON error responses", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        {
          success: false,
          error: "Authentication required",
          code: "session_auth_required",
        },
        { status: 401 },
      ),
    );
    api.setBaseUrl("https://api.example.test");

    await expect(api.get("/api/session")).rejects.toMatchObject({
      name: "ApiError",
      message: "Authentication required",
      status: 401,
      code: "session_auth_required",
    } satisfies Partial<ApiError>);
  });

  test("uses text response bodies as non-JSON error messages", async () => {
    globalThis.fetch = vi.fn(async () => new Response("service unavailable", { status: 503 }));

    await expect(api.get("/api/session")).rejects.toMatchObject({
      message: "Request failed with status 503",
      status: 503,
      code: "HTTP_503",
    });
  });

  test("encodes query params and omits only undefined values", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;
    api.setBaseUrl("https://api.example.test");

    await api.get("/api/items", {
      params: {
        active: false,
        count: 0,
        q: "hello",
        skip: undefined,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/items?active=false&count=0&q=hello",
      expect.any(Object),
    );
  });

  test("removes manual content-type for FormData bodies", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;
    const form = new FormData();
    form.set("file", "hello");

    await api.request("POST", "/api/upload", { body: form });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: form,
        headers: {},
      }),
    );
  });

  test("authenticated client adds bearer token without dropping caller headers", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;

    await createAuthenticatedClient("session-token").get("/api/session", {
      headers: { "X-Client": "mobile" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Client": "mobile",
          Authorization: "Bearer session-token",
        },
      }),
    );
  });
});

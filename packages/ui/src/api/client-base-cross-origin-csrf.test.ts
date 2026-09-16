// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCsrfTokenForUrl,
  rememberCsrfTokenForUrl,
} from "./auth/csrf-cookie";
import { CSRF_COOKIE_NAME } from "./auth/sessions";
import { ElizaClient } from "./client";

const REMOTE_BASE = "http://192.168.1.30:31340";

function setDocumentCookie(pair: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: seeds the page-origin cookie jar used by the production helper.
  document.cookie = pair;
}

afterEach(() => {
  setDocumentCookie(`${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/`);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("cross-origin native CSRF mirror", () => {
  it("scopes a login response token to the matching API origin", () => {
    rememberCsrfTokenForUrl(REMOTE_BASE, "remote-csrf-token");

    expect(readCsrfTokenForUrl(`${REMOTE_BASE}/api/conversations`)).toBe(
      "remote-csrf-token",
    );
    expect(
      readCsrfTokenForUrl("http://192.168.1.31:31340/api/conversations"),
    ).toBeNull();
  });

  it("prefers the remote-origin mirror over a stale page-origin cookie", () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=page-csrf-token; Path=/`);
    rememberCsrfTokenForUrl(REMOTE_BASE, "remote-csrf-token");

    expect(readCsrfTokenForUrl(`${REMOTE_BASE}/api/conversations`)).toBe(
      "remote-csrf-token",
    );
  });

  it("sends the remote token when the page cookie is stale", async () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=page-csrf-token; Path=/`);
    rememberCsrfTokenForUrl(REMOTE_BASE, "remote-csrf-token");
    const request = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ElizaClient(REMOTE_BASE);
    client.setRequestTransport({ request });

    await client.rawRequest("/api/conversations", { method: "POST" });

    const headers = new Headers(request.mock.calls[0]?.[1].headers);
    expect(headers.get("x-eliza-csrf")).toBe("remote-csrf-token");
    expect(request.mock.calls[0]?.[1].credentials).toBe("include");
  });
});

import { describe, expect, test } from "vitest";
import {
  buildForwardHeaders,
  shouldForwardToRemoteTarget,
} from "./remote-forwarder";

describe("shouldForwardToRemoteTarget", () => {
  test("forwards POST /api/cloud/login", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/login", "POST")).toBe(true);
  });

  test("forwards POST /api/cloud/disconnect", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/disconnect", "POST")).toBe(
      true,
    );
  });

  test("forwards mutations under /api/cloud/billing/", () => {
    expect(
      shouldForwardToRemoteTarget("/api/cloud/billing/portal", "POST"),
    ).toBe(true);
    expect(
      shouldForwardToRemoteTarget("/api/cloud/billing/portal", "GET"),
    ).toBe(false);
  });

  test("forwards mutations under /api/cloud/v1/", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/v1/agents", "POST")).toBe(
      true,
    );
    expect(shouldForwardToRemoteTarget("/api/cloud/v1/agents", "DELETE")).toBe(
      true,
    );
  });

  test("does not forward GET requests", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/login", "GET")).toBe(false);
  });

  test("does not forward unrelated paths", () => {
    expect(shouldForwardToRemoteTarget("/api/agent/reset", "POST")).toBe(false);
  });
});

describe("buildForwardHeaders", () => {
  test("preserves array-valued headers via append (RFC 7230 multi-value)", () => {
    // `set-cookie` is the canonical multi-valued request/response header
    // — Node parses it as `string[]` whenever a peer sends multiple
    // values. Anything iterating over `req.headers` and assuming string
    // values silently drops every entry beyond the first. Forward all
    // values via `headers.append`.
    const headers = buildForwardHeaders(
      {
        "set-cookie": ["session=abc", "remember=1"],
        accept: "application/json",
      },
      "target.local:31337",
      null,
    );

    // `Headers.getSetCookie` is the only API that preserves the array
    // shape for `set-cookie`; for general headers RFC 7230 says
    // comma-join is equivalent. We assert both array entries survive.
    const cookies = headers.getSetCookie();
    expect(cookies).toContain("session=abc");
    expect(cookies).toContain("remember=1");
  });

  test("strips hop-by-hop headers", () => {
    const headers = buildForwardHeaders(
      {
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "x-trace-id": "abc",
      },
      "target.local",
      null,
    );
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("transfer-encoding")).toBe(false);
    expect(headers.get("x-trace-id")).toBe("abc");
  });

  test("rewrites Host to the target", () => {
    const headers = buildForwardHeaders(
      { host: "controller.local", "x-keep": "yes" },
      "target.local:31337",
      null,
    );
    expect(headers.get("host")).toBe("target.local:31337");
    expect(headers.get("x-keep")).toBe("yes");
  });

  test("injects Bearer authorization when remoteAccessToken is set", () => {
    const headers = buildForwardHeaders({}, "target.local", "secret-token");
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("does not inject authorization when token is null", () => {
    const headers = buildForwardHeaders({}, "target.local", null);
    expect(headers.has("authorization")).toBe(false);
  });
});

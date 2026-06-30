import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared.ts";
import { handleCredentialTunnelRoute } from "./credential-tunnel-routes.ts";
import { CredentialScopeError } from "../services/credential-tunnel-service.ts";

function fakeReq(body: unknown): http.IncomingMessage {
  // readCompatJsonBody honours a pre-parsed `req.body` object.
  return { body } as unknown as http.IncomingMessage;
}

function fakeRes(): {
  res: http.ServerResponse;
  status: () => number;
  body: () => unknown;
} {
  let statusCode = 0;
  let payload = "";
  const res = {
    headersSent: false,
    setHeader() {},
    end(chunk?: string) {
      if (chunk) payload = chunk;
      (res as { headersSent: boolean }).headersSent = true;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    get statusCode() {
      return statusCode;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => (payload ? JSON.parse(payload) : null),
  };
}

function makeState(
  bridge: { tunnelCredential: (input: unknown) => Promise<void> } | null,
): CompatRuntimeState {
  return {
    current:
      bridge === null
        ? null
        : ({
            getService: (name: string) =>
              name === "SubAgentCredentialBridge" ? bridge : null,
          } as unknown as CompatRuntimeState["current"]),
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

const VALID_BODY = {
  credentialScopeId: "cred_scope_0011223344556677",
  childSessionId: "pty-1-abc",
  key: "OPENAI_API_KEY",
  value: "sk-secret",
};

describe("handleCredentialTunnelRoute", () => {
  it("ignores non-matching method/path", async () => {
    const { res } = fakeRes();
    expect(
      await handleCredentialTunnelRoute(
        fakeReq({}),
        res,
        makeState({ tunnelCredential: vi.fn() }),
        "GET",
        "/api/credential-tunnel/submit",
      ),
    ).toBe(false);
    expect(
      await handleCredentialTunnelRoute(
        fakeReq({}),
        res,
        makeState({ tunnelCredential: vi.fn() }),
        "POST",
        "/api/other",
      ),
    ).toBe(false);
  });

  it("calls bridge.tunnelCredential for a valid owner-authenticated submit", async () => {
    const tunnelCredential = vi.fn().mockResolvedValue(undefined);
    const { res, status, body } = fakeRes();

    const handled = await handleCredentialTunnelRoute(
      fakeReq(VALID_BODY),
      res,
      makeState({ tunnelCredential }),
      "POST",
      "/api/credential-tunnel/submit",
    );

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(tunnelCredential).toHaveBeenCalledWith({
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_0011223344556677",
      key: "OPENAI_API_KEY",
      value: "sk-secret",
    });
  });

  it("rejects an out-of-scope key with 403 (key_not_in_scope)", async () => {
    const tunnelCredential = vi.fn().mockRejectedValue(
      new CredentialScopeError("key_not_in_scope", "key AWS_SECRET not declared"),
    );
    const { res, status, body } = fakeRes();

    await handleCredentialTunnelRoute(
      fakeReq({ ...VALID_BODY, key: "AWS_SECRET" }),
      res,
      makeState({ tunnelCredential }),
      "POST",
      "/api/credential-tunnel/submit",
    );

    expect(status()).toBe(403);
    expect((body() as { code: string }).code).toBe("key_not_in_scope");
  });

  it("maps an expired scope to 410", async () => {
    const tunnelCredential = vi
      .fn()
      .mockRejectedValue(new CredentialScopeError("scope_expired", "expired"));
    const { res, status, body } = fakeRes();

    await handleCredentialTunnelRoute(
      fakeReq(VALID_BODY),
      res,
      makeState({ tunnelCredential }),
      "POST",
      "/api/credential-tunnel/submit",
    );

    expect(status()).toBe(410);
    expect((body() as { code: string }).code).toBe("scope_expired");
  });

  it("returns 503 when no bridge service is registered (sandboxed / child runtime)", async () => {
    const { res, status, body } = fakeRes();
    await handleCredentialTunnelRoute(
      fakeReq(VALID_BODY),
      res,
      makeState(null),
      "POST",
      "/api/credential-tunnel/submit",
    );
    expect(status()).toBe(503);
    expect((body() as { code: string }).code).toBe("no_adapter");
  });

  it("rejects an incomplete body with 400", async () => {
    const tunnelCredential = vi.fn();
    const { res, status, body } = fakeRes();
    await handleCredentialTunnelRoute(
      fakeReq({ credentialScopeId: "x", key: "K" }),
      res,
      makeState({ tunnelCredential }),
      "POST",
      "/api/credential-tunnel/submit",
    );
    expect(status()).toBe(400);
    expect((body() as { code: string }).code).toBe("invalid_body");
    expect(tunnelCredential).not.toHaveBeenCalled();
  });
});

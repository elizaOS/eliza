/**
 * Fail-closed observability for auth-store read failures (#12266).
 *
 * `resolveAuthorizedRouteRole` looks a session up via `findActiveSession`, which
 * rejects only on a real infrastructure failure ("not found" resolves to null).
 * The route layer must fail closed (deny) on such a rejection, but it must ALSO
 * surface it — a silent `.catch(() => null)` turned a broken auth DB into an
 * indistinguishable stream of 401s. These tests drive the real guard with a
 * store whose `findSession` throws and assert: (a) the request is denied 401,
 * and (b) the failure reached the structured logger. The legitimate-absence
 * case (store returns null) is denied WITHOUT a logged error, proving the log
 * fires only on genuine failure.
 */
import http from "node:http";
import { Socket } from "node:net";
import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStore } from "../services/auth-store";
import {
  _resetAuthRateLimiter,
  ensureCompatApiAuthorizedAsync,
  getSessionCookieName,
} from "./auth.ts";

function reqWithSessionCookie(remoteAddress: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/compat/thing";
  req.headers = {
    host: "example.test:2138",
    cookie: `${getSessionCookieName()}=session-abc`,
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
  return req;
}

function fakeRes() {
  const inner = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(inner);
  let body = "";
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return { res, status: () => res.statusCode, body: () => body };
}

describe("auth-store read failure surfaces + fails closed", () => {
  beforeEach(() => {
    _resetAuthRateLimiter();
    vi.restoreAllMocks();
  });

  it("denies 401 AND logs when the session store read throws", async () => {
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined as never);
    const throwingStore = {
      findSession: async () => {
        throw new Error("auth db connection refused");
      },
    } as unknown as AuthStore;

    const { res, status } = fakeRes();
    const authorized = await ensureCompatApiAuthorizedAsync(
      reqWithSessionCookie("203.0.113.9"),
      res,
      { store: throwingStore, skipCsrf: true },
    );

    expect(authorized).toBe(false);
    expect(status()).toBe(401);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Structured logger is pino-style: (contextObject, message).
    const [context, message] = errorSpy.mock.calls[0] as [
      { scope?: string; error?: string },
      string,
    ];
    expect(String(message)).toContain("cookieSession failed; failing closed");
    expect(context.scope).toContain("cookieSession");
    expect(String(context.error)).toContain("auth db connection refused");
  });

  it("denies 401 WITHOUT logging when the session is legitimately absent", async () => {
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined as never);
    const emptyStore = {
      findSession: async () => null,
    } as unknown as AuthStore;

    const { res, status } = fakeRes();
    const authorized = await ensureCompatApiAuthorizedAsync(
      reqWithSessionCookie("203.0.113.10"),
      res,
      { store: emptyStore, skipCsrf: true },
    );

    expect(authorized).toBe(false);
    expect(status()).toBe(401);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

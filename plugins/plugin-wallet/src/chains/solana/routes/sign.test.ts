/**
 * Unit tests for the Solana browser-signing HTTP routes: auth-token
 * validation (bearer/header token, origin checks) and request/response
 * shaping. `resolveWalletBackend` is mocked, so no real Solana signer or RPC
 * is exercised.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { solanaSignRoutes } from "./sign";

const walletBackendMocks = vi.hoisted(() => ({
  resolveWalletBackend: vi.fn(),
}));

vi.mock("../../../wallet/select-backend", () => ({
  resolveWalletBackend: walletBackendMocks.resolveWalletBackend,
}));

function runtime(token: string | null): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => (key === "WALLET_BROWSER_SIGN_TOKEN" ? token : undefined)),
  } as unknown as IAgentRuntime;
}

function req(args: {
  method?: string;
  authorization?: string;
  xToken?: string;
  origin?: string;
  body?: unknown;
}): RouteRequest {
  return {
    method: args.method ?? "POST",
    headers: {
      ...(args.authorization ? { authorization: args.authorization } : {}),
      ...(args.xToken ? { "x-wallet-sign-token": args.xToken } : {}),
      ...(args.origin ? { origin: args.origin } : {}),
    },
    body: args.body,
  } as unknown as RouteRequest;
}

function res(): RouteResponse & {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
} {
  const response = {
    headers: {} as Record<string, string>,
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  return response as unknown as RouteResponse & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  };
}

function route(name: string) {
  const found = solanaSignRoutes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing route ${name}`);
  if (!found.handler) throw new Error(`route ${name} has no handler`);
  return { ...found, handler: found.handler };
}

describe("Solana browser signing routes", () => {
  beforeEach(() => {
    walletBackendMocks.resolveWalletBackend.mockReset();
  });

  it("does not mark browser signing routes as public", () => {
    expect(solanaSignRoutes).toHaveLength(6);
    expect(solanaSignRoutes.every((candidate) => candidate.public !== true)).toBe(true);
  });

  it("closes the surface when the signing token is missing or too short", async () => {
    for (const token of [null, "short-token"]) {
      const response = res();
      await route("wallet-solana-pubkey").handler(
        req({ authorization: "Bearer short-token" }),
        response,
        runtime(token)
      );

      expect(response.statusCode).toBe(503);
      expect(response.body).toEqual({
        error: "WALLET_BROWSER_SIGN_TOKEN not configured",
      });
    }
  });

  it("rejects malformed authorization schemes and bad header tokens", async () => {
    for (const request of [
      req({ authorization: "Basic 1234567890abcdef" }),
      req({ xToken: "wrong-token" }),
    ]) {
      const response = res();
      await route("wallet-solana-pubkey").handler(request, response, runtime("1234567890abcdef"));

      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ error: "invalid sign token" });
    }
  });

  it("never reflects an arbitrary cross-origin or sends credentialed CORS", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "https://attacker.example" }),
      response,
      runtime("1234567890abcdef")
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toEqual({});
    // ACAO must NOT echo the attacker origin, and credentials must be absent.
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(response.headers["Access-Control-Allow-Credentials"]).not.toBe("true");
    expect(response.headers["Access-Control-Allow-Headers"]).toContain("X-Wallet-Sign-Token");
  });

  it("allows a loopback origin without credentialed CORS", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "http://127.0.0.1:2138" }),
      response,
      runtime("1234567890abcdef")
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:2138");
    expect(response.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("gates every Solana signing route behind the browser signing token", async () => {
    // public: true for the cross-origin browser signing surface, so the central
    // session gate does not protect them — their WALLET_BROWSER_SIGN_TOKEN check
    // must. Assert each is closed (503) before any backend work without a token.
    const signingRouteNames = [
      "wallet-solana-sign-transaction",
      "wallet-solana-sign-all-transactions",
      "wallet-solana-sign-message",
      "wallet-solana-sign-and-send-transaction",
    ];

    for (const routeName of signingRouteNames) {
      const response = res();
      await route(routeName).handler(
        req({ authorization: "Bearer caller-token", body: {} }),
        response,
        runtime(null)
      );
      expect(response.statusCode).toBe(503);
      expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
    }
  });

  it("validates message body shape before resolving wallet backend", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({
        authorization: "Bearer 1234567890abcdef",
        body: { messageBase64: 42 },
      }),
      response,
      runtime("1234567890abcdef")
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "messageBase64 required" });
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });

  it("rejects malformed base64 messages before resolving wallet backend", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({
        authorization: "Bearer 1234567890abcdef",
        body: { messageBase64: "not base64!?" },
      }),
      response,
      runtime("1234567890abcdef")
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid base64 payload" });
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });

  it("rejects invalid transaction bytes before resolving wallet backend", async () => {
    const response = res();
    await route("wallet-solana-sign-transaction").handler(
      req({
        authorization: "Bearer 1234567890abcdef",
        body: { transactionBase64: Buffer.from("not a tx").toString("base64") },
      }),
      response,
      runtime("1234567890abcdef")
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid transaction payload" });
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });
});

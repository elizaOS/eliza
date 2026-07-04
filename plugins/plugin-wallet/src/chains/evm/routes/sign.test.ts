/**
 * Unit tests for the browser EVM signing HTTP routes (`evmSignRoutes`):
 * token-gating (503 when unconfigured, 401 on a wrong token), CORS behavior
 * (no credentialed cross-origin reflection, loopback origins allowed), and
 * request validation (chain id, bigint fields) short-circuiting before the
 * wallet backend is ever touched. `resolveWalletBackend` is mocked — no
 * real signing occurs.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evmSignRoutes } from "./sign";

const walletBackendMocks = vi.hoisted(() => ({
  resolveWalletBackend: vi.fn(),
}));

vi.mock("../../../wallet/select-backend", () => ({
  resolveWalletBackend: walletBackendMocks.resolveWalletBackend,
}));

function runtime(token: string | null): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) =>
      key === "WALLET_BROWSER_SIGN_TOKEN" ? token : undefined,
    ),
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
  const found = evmSignRoutes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing route ${name}`);
  if (!found.handler) throw new Error(`route ${name} has no handler`);
  return { ...found, handler: found.handler };
}

describe("EVM browser signing routes", () => {
  beforeEach(() => {
    walletBackendMocks.resolveWalletBackend.mockReset();
  });

  it("does not mark browser signing routes as public", () => {
    expect(evmSignRoutes).toHaveLength(6);
    expect(evmSignRoutes.every((candidate) => candidate.public !== true)).toBe(
      true,
    );
  });

  it("closes the surface when the signing token is missing or too short", async () => {
    for (const token of [null, "short-token"]) {
      const response = res();
      await route("wallet-evm-address").handler(
        req({ authorization: "Bearer short-token" }),
        response,
        runtime(token),
      );

      expect(response.statusCode).toBe(503);
      expect(response.body).toEqual({
        error: "WALLET_BROWSER_SIGN_TOKEN not configured",
      });
    }
  });

  it("rejects bad bearer/header tokens without leaking a credentialed CORS origin", async () => {
    const response = res();
    await route("wallet-evm-address").handler(
      req({
        authorization: "Bearer wrong-token",
        origin: "https://dapp.example",
      }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "invalid sign token" });
    expect(response.headers.Vary).toBe("Origin");
  });

  it("never reflects an arbitrary cross-origin or sends credentialed CORS", async () => {
    const response = res();
    await route("wallet-evm-personal-sign").handler(
      req({
        method: "OPTIONS",
        origin: "https://attacker.example",
      }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(204);
    // ACAO must NOT echo the attacker origin, and credentials must be absent.
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(response.headers["Access-Control-Allow-Credentials"]).not.toBe(
      "true",
    );
  });

  it("allows a loopback origin without credentialed CORS", async () => {
    const response = res();
    await route("wallet-evm-personal-sign").handler(
      req({ method: "OPTIONS", origin: "http://localhost:31337" }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:31337",
    );
    expect(response.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("handles OPTIONS without touching wallet backends", async () => {
    const response = res();
    await route("wallet-evm-personal-sign").handler(
      req({ method: "OPTIONS", origin: "http://127.0.0.1:2138" }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toEqual({});
    expect(response.headers["Access-Control-Allow-Methods"]).toContain(
      "OPTIONS",
    );
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });

  it("gates every EVM signing route behind the browser signing token", async () => {
    // These routes are public: true so the cross-origin browser signing surface
    // can reach them, so the central session gate does NOT protect them — their
    // own WALLET_BROWSER_SIGN_TOKEN check must. Assert each one is closed (503)
    // before any backend work when no signing token is configured.
    const signingRouteNames = [
      "wallet-evm-personal-sign",
      "wallet-evm-sign-typed-data",
      "wallet-evm-sign-transaction",
      "wallet-evm-send-transaction",
    ];

    for (const routeName of signingRouteNames) {
      const response = res();
      await route(routeName).handler(
        req({ authorization: "Bearer caller-token", body: {} }),
        response,
        runtime(null),
      );
      expect(response.statusCode).toBe(503);
      expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed chain ids before resolving the backend", async () => {
    const response = res();
    await route("wallet-evm-sign-transaction").handler(
      req({
        authorization: "Bearer 1234567890abcdef",
        body: {
          chainId: "not-a-number",
          tx: { to: "0x0000000000000000000000000000000000000000" },
        },
      }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "chainId must be a number or hex string",
    });
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });

  it("rejects unsupported chain ids before resolving the backend", async () => {
    const response = res();
    await route("wallet-evm-send-transaction").handler(
      req({
        authorization: "Bearer 1234567890abcdef",
        body: {
          chainId: -1,
          tx: { to: "0x0000000000000000000000000000000000000000" },
        },
      }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "unsupported EVM chainId: -1",
    });
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });

  it("rejects malformed bigint transaction fields as client errors", async () => {
    const getEvmAccount = vi.fn(() => ({
      address: "0x0000000000000000000000000000000000000001",
    }));
    walletBackendMocks.resolveWalletBackend.mockResolvedValueOnce({
      getEvmAccount,
    });
    const response = res();

    await route("wallet-evm-sign-transaction").handler(
      req({
        authorization: "Bearer 1234567890abcdef",
        body: {
          chainId: 1,
          tx: {
            to: "0x0000000000000000000000000000000000000000",
            value: "not-a-bigint",
          },
        },
      }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid bigint value: not-a-bigint" });
    expect(walletBackendMocks.resolveWalletBackend).toHaveBeenCalledTimes(1);
    expect(getEvmAccount).toHaveBeenCalledWith(1);
  });
});

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
  return response as RouteResponse & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  };
}

function route(name: string) {
  const found = evmSignRoutes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing route ${name}`);
  return found;
}

describe("EVM browser signing routes", () => {
  beforeEach(() => {
    walletBackendMocks.resolveWalletBackend.mockReset();
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

  it("rejects bad bearer/header tokens and sets CORS headers from origin", async () => {
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
    expect(response.headers["Access-Control-Allow-Origin"]).toBe(
      "https://dapp.example",
    );
    expect(response.headers.Vary).toBe("Origin");
  });

  it("handles OPTIONS without touching wallet backends", async () => {
    const response = res();
    await route("wallet-evm-personal-sign").handler(
      req({ method: "OPTIONS", origin: "https://dapp.example" }),
      response,
      runtime("1234567890abcdef"),
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toEqual({});
    expect(response.headers["Access-Control-Allow-Methods"]).toContain(
      "OPTIONS",
    );
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

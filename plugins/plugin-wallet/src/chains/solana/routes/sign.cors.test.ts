import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { solanaSignRoutes } from "./sign";

const walletBackendMocks = vi.hoisted(() => ({
  resolveWalletBackend: vi.fn(),
}));

vi.mock("../../../wallet/select-backend", () => ({
  resolveWalletBackend: walletBackendMocks.resolveWalletBackend,
}));

function runtime(settings: Record<string, string | null>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? undefined),
  } as unknown as IAgentRuntime;
}

function req(args: {
  method?: string;
  authorization?: string;
  origin?: string;
  body?: unknown;
}): RouteRequest {
  return {
    method: args.method ?? "POST",
    headers: {
      ...(args.authorization ? { authorization: args.authorization } : {}),
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
  if (!found?.handler) throw new Error(`missing route ${name}`);
  return { ...found, handler: found.handler };
}

const TOKEN = "1234567890abcdef";

describe("Solana browser signing CORS hardening", () => {
  beforeEach(() => {
    walletBackendMocks.resolveWalletBackend.mockReset();
    delete process.env.WALLET_BROWSER_SIGN_ORIGINS;
  });

  afterEach(() => {
    delete process.env.WALLET_BROWSER_SIGN_ORIGINS;
  });

  it("never sets Access-Control-Allow-Credentials (no credentialed CORS)", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "https://dapp.example" }),
      response,
      runtime({
        WALLET_BROWSER_SIGN_TOKEN: TOKEN,
        WALLET_BROWSER_SIGN_ORIGINS: "https://dapp.example",
      })
    );

    expect(response.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("does not reflect a non-allowlisted origin", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "https://evil.example" }),
      response,
      runtime({
        WALLET_BROWSER_SIGN_TOKEN: TOKEN,
        WALLET_BROWSER_SIGN_ORIGINS: "https://dapp.example",
      })
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(response.headers.Vary).toBe("Origin");
  });

  it("reflects an allowlisted origin from runtime settings", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "https://dapp.example" }),
      response,
      runtime({
        WALLET_BROWSER_SIGN_TOKEN: TOKEN,
        WALLET_BROWSER_SIGN_ORIGINS: "https://other.example, https://dapp.example",
      })
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("https://dapp.example");
    expect(response.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("reads the allowlist from the environment when runtime setting is unset", async () => {
    process.env.WALLET_BROWSER_SIGN_ORIGINS = "https://dapp.example";
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "https://dapp.example" }),
      response,
      runtime({ WALLET_BROWSER_SIGN_TOKEN: TOKEN })
    );

    expect(response.headers["Access-Control-Allow-Origin"]).toBe("https://dapp.example");
  });

  it("denies cross-origin by default when no allowlist is configured", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ method: "OPTIONS", origin: "https://dapp.example" }),
      response,
      runtime({ WALLET_BROWSER_SIGN_TOKEN: TOKEN })
    );

    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("still 503s when the sign token is not configured", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({ authorization: `Bearer ${TOKEN}`, origin: "https://dapp.example" }),
      response,
      runtime({ WALLET_BROWSER_SIGN_ORIGINS: "https://dapp.example" })
    );

    expect(response.statusCode).toBe(503);
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });

  it("still 401s when the bearer token is missing", async () => {
    const response = res();
    await route("wallet-solana-sign-message").handler(
      req({
        origin: "https://dapp.example",
        body: { messageBase64: Buffer.from("hi").toString("base64") },
      }),
      response,
      runtime({
        WALLET_BROWSER_SIGN_TOKEN: TOKEN,
        WALLET_BROWSER_SIGN_ORIGINS: "https://dapp.example",
      })
    );

    expect(response.statusCode).toBe(401);
    expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
  });
});

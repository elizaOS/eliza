/** EVM signing routes accept only canonical decimal or hexadecimal chain IDs. */
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

function req(body: unknown): RouteRequest {
  return {
    method: "POST",
    headers: { authorization: "Bearer 1234567890abcdef" },
    body,
  } as unknown as RouteRequest;
}

function res(): RouteResponse & {
  statusCode?: number;
  body?: unknown;
} {
  const response = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
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
  return response as unknown as RouteResponse & {
    statusCode?: number;
    body?: unknown;
  };
}

function route(name: string) {
  const found = evmSignRoutes.find((candidate) => candidate.name === name);
  if (!found?.handler) throw new Error(`missing route ${name}`);
  return found.handler;
}

describe("EVM sign chainId validation", () => {
  beforeEach(() => {
    walletBackendMocks.resolveWalletBackend.mockReset();
  });

  it.each([
    "1e2",
    "007",
    "0",
    "0x0",
    "0x10junk",
    "12px",
    "9007199254740992",
  ])(
    "rejects non-canonical chainId %s before resolving the backend",
    async (chainId) => {
      const response = res();
      await route("wallet-evm-sign-transaction")(
        req({
          chainId,
          tx: { to: "0x0000000000000000000000000000000000000000" },
        }),
        response,
        runtime("1234567890abcdef"),
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: "chainId must be a number or hex string",
      });
      expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid numeric chainId %s before resolving the backend",
    async (chainId) => {
      const response = res();
      await route("wallet-evm-sign-transaction")(
        req({
          chainId,
          tx: { to: "0x0000000000000000000000000000000000000000" },
        }),
        response,
        runtime("1234567890abcdef"),
      );

      expect(response.statusCode).toBe(400);
      expect(walletBackendMocks.resolveWalletBackend).not.toHaveBeenCalled();
    },
  );

  it.each(["1", "0x1"])(
    "still accepts canonical chainId %s and reaches the backend",
    async (chainId) => {
      const getEvmAccount = vi.fn(() => ({
        address: "0x0000000000000000000000000000000000000001",
      }));
      walletBackendMocks.resolveWalletBackend.mockResolvedValueOnce({
        getEvmAccount,
      });
      const response = res();
      await route("wallet-evm-sign-transaction")(
        req({
          chainId,
          tx: {
            to: "0x0000000000000000000000000000000000000000",
            value: "not-a-bigint",
          },
        }),
        response,
        runtime("1234567890abcdef"),
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: "invalid bigint value: not-a-bigint",
      });
      expect(walletBackendMocks.resolveWalletBackend).toHaveBeenCalledTimes(1);
      expect(getEvmAccount).toHaveBeenCalledWith(1);
    },
  );
});

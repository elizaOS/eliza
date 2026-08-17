/**
 * Exercises public token-chain validation through the HTTP route with a mocked
 * character repository boundary.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const SOLANA_TOKEN = "So11111111111111111111111111111111111111112";
const EVM_TOKEN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function publicAgent(overrides: {
  id: string;
  token_address: string;
  token_chain: string;
}) {
  return {
    id: overrides.id,
    name: "Linked agent",
    username: "linked",
    avatar_url: null,
    bio: "public",
    is_public: true,
    token_address: overrides.token_address,
    token_chain: overrides.token_chain,
    token_name: "Tok",
    token_ticker: "TOK",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const findByTokenAddress = mock(
  async (_tokenAddress: string, _tokenChain?: string) =>
    publicAgent({
      id: "char-sol",
      token_address: SOLANA_TOKEN,
      token_chain: "solana",
    }),
);

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByTokenAddress },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ success: false, error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/agents/by-token", route);

function lookup(query: string) {
  return app.request(`/api/v1/agents/by-token${query}`);
}

describe("GET /api/v1/agents/by-token token-rail identity", () => {
  beforeEach(() => {
    findByTokenAddress.mockClear();
    findByTokenAddress.mockResolvedValue(
      publicAgent({
        id: "char-sol",
        token_address: SOLANA_TOKEN,
        token_chain: "solana",
      }),
    );
  });

  test.each(["", "&chain="])(
    "accepts %s as the unfiltered public token lookup",
    async (chainQuery) => {
      const response = await lookup(`?address=${SOLANA_TOKEN}${chainQuery}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        data: { id: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("char-sol");
      expect(findByTokenAddress).toHaveBeenCalledTimes(1);
      expect(findByTokenAddress.mock.calls[0][1]).toBeUndefined();
    },
  );

  test("accepts chain=solana as the Solana public token rail", async () => {
    const response = await lookup(`?address=${SOLANA_TOKEN}&chain=solana`);
    expect(response.status).toBe(200);
    expect(findByTokenAddress).toHaveBeenCalledTimes(1);
    expect(findByTokenAddress.mock.calls[0][1]).toBe("solana");
  });

  test("accepts chain=eth as the documented public token-rail alias", async () => {
    findByTokenAddress.mockResolvedValueOnce(
      publicAgent({
        id: "char-eth",
        token_address: EVM_TOKEN,
        token_chain: "eth",
      }),
    );
    const response = await lookup(`?address=${EVM_TOKEN}&chain=eth`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string } };
    expect(body.data.id).toBe("char-eth");
    expect(findByTokenAddress.mock.calls[0][1]).toBe("eth");
  });

  test("accepts an extensible canonical lowercase chain id", async () => {
    const response = await lookup(`?address=${EVM_TOKEN}&chain=arbitrum`);

    expect(response.status).toBe(200);
    expect(findByTokenAddress.mock.calls[0][1]).toBe("arbitrum");
  });

  test.each(["SOLANA", "ETH", "Ethereum", "foo!", "1e2"])(
    "rejects chain=%s before findByTokenAddress",
    async (token) => {
      const response = await lookup(
        `?address=${SOLANA_TOKEN}&chain=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(body.success).toBe(false);
      expect(body.error).toContain("Invalid chain");
      expect(findByTokenAddress).not.toHaveBeenCalled();
    },
  );
});

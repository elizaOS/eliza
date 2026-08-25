/** Verifies wallet-provision JSON handling with deterministic identity and storage mocks. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HonoRequest } from "hono/request";
import type { ProvisionWalletParams } from "@/lib/services/server-wallets";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORG_ID = "00000000-0000-4000-8000-0000000000bb";
const CLIENT_ADDRESS = "0x1111111111111111111111111111111111111111";

const requireUserOrApiKey = mock(async () => ({
  id: USER_ID,
  organization: { id: ORG_ID },
}));

const provisionServerWallet = mock(
  async (
    _params: ProvisionWalletParams,
  ): Promise<{
    id: string;
    address: string;
    chain_type: string;
    client_address: string;
  }> => {
    throw new Error("provisionServerWallet must not run");
  },
);

const failureResponse = mock(
  (c: { json: (body: unknown, status: number) => unknown }) =>
    c.json({ success: false, error: "An unexpected error occurred" }, 500),
);

mock.module("viem", () => ({
  isAddress: (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value),
}));

mock.module("drizzle-orm", () => ({
  and: mock(() => ({})),
  eq: mock(() => ({})),
}));

mock.module("@/db/helpers", () => ({
  dbWrite: {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => []),
        })),
      })),
    })),
  },
}));

mock.module("@/db/schemas/agent-server-wallets", () => ({
  agentServerWallets: {
    id: "id",
    address: "address",
    chain_type: "chain_type",
    client_address: "client_address",
    organization_id: "organization_id",
  },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey,
}));

mock.module("@/lib/services/server-wallets", () => ({
  provisionServerWallet,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: raw,
    }),
  );
}

const validBody = {
  chainType: "evm",
  clientAddress: CLIENT_ADDRESS,
  controlProof: {
    signature: "0xab",
    timestamp: 1,
    nonce: "n1",
  },
};

describe("POST /api/v1/user/wallets/provision JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKey.mockClear();
    provisionServerWallet.mockClear();
    failureResponse.mockClear();
    provisionServerWallet.mockImplementation(async () => {
      throw new Error("provisionServerWallet must not run");
    });
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed provision body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toEqual({
        success: false,
        error: "Invalid JSON body",
      });
      expect(requireUserOrApiKey).toHaveBeenCalled();
      expect(provisionServerWallet).not.toHaveBeenCalled();
      expect(failureResponse).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing fields via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
    expect(provisionServerWallet).not.toHaveBeenCalled();
  });

  test("preserves non-syntax request decoding failures as server errors", async () => {
    const originalText = HonoRequest.prototype.text;
    HonoRequest.prototype.text = mock(async () => {
      throw new Error("request stream failed");
    }) as typeof HonoRequest.prototype.text;

    try {
      const res = await post(JSON.stringify(validBody));
      expect(res.status).toBe(500);
      expect(provisionServerWallet).not.toHaveBeenCalled();
      expect(failureResponse).toHaveBeenCalled();
    } finally {
      HonoRequest.prototype.text = originalText;
    }
  });

  test("still provisions a canonical object body", async () => {
    provisionServerWallet.mockResolvedValue({
      id: "wallet-1",
      address: "0x2222222222222222222222222222222222222222",
      chain_type: "evm",
      client_address: CLIENT_ADDRESS,
    });

    const res = await post(JSON.stringify(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        id: "wallet-1",
        address: "0x2222222222222222222222222222222222222222",
        chainType: "evm",
        clientAddress: CLIENT_ADDRESS,
      },
    });
    expect(provisionServerWallet).toHaveBeenCalledTimes(1);
    expect(provisionServerWallet.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      clientAddress: CLIENT_ADDRESS,
      chainType: "evm",
    });
  });
});

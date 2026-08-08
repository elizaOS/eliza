/**
 * What a waifu-core service token may assert about a WALLET when it provisions
 * an eliza-cloud account. Real `authenticateWaifuBridge` and a real HS256 token
 * signed with the shared secret; only the user/org writers are mocked, so the
 * assertion is the exact row this path asks for.
 *
 * The token is a service credential, not an end-user authentication: its
 * `userId` is a naming convention, so `waifu:0x<address>` is chosen by whoever
 * holds `ELIZA_SERVICE_JWT_SECRET` and proves nothing about the address. Cloud
 * verifies no SIWE/SIWS signature anywhere in this chain. Recording
 * `wallet_verified: true` here handed that address a permanent no-reply identity
 * at every relying party with `wallet_email_fallback` — a victim's public wallet
 * becomes the attacker's git author address at the forge — so the row must
 * carry the address as a lookup key and nothing more.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";

const SECRET = "waifu-bridge-shared-service-secret-0123456789";
const VICTIM_WALLET = "0xAAaaBBbbCCccDDddEEeeFFff0011223344556677";
const ORG_ID = "11111111-1111-4111-8111-111111111111";

process.env.ELIZA_SERVICE_JWT_SECRET = SECRET;
process.env.WAIFU_BRIDGE_ORG_ID = ORG_ID;

const createCalls: Array<Record<string, unknown>> = [];

mock.module("../services/users", () => ({
  usersService: {
    getByStewardId: async () => undefined,
    getByWalletAddressWithOrganization: async () => undefined,
    create: async (data: Record<string, unknown>) => {
      createCalls.push(data);
      return { id: "user-waifu" };
    },
    getWithOrganization: async () => ({
      id: "user-waifu",
      organization_id: ORG_ID,
      organization: { id: ORG_ID, name: "waifu" },
    }),
  },
}));

mock.module("../services/organizations", () => ({
  organizationsService: {
    create: async () => {
      throw new Error("a pinned WAIFU_BRIDGE_ORG_ID must not create an organization");
    },
    getBySlug: async () => undefined,
  },
}));

mock.module("../../db/helpers", () => ({
  dbWrite: {
    insert: () => ({
      values: async () => undefined,
    }),
  },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { authenticateWaifuBridge } = await import("./waifu-bridge");

async function bridgeRequest(userId: string): Promise<Request> {
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
  return new Request("https://api.elizacloud.test/api/waifu/echo", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  createCalls.length = 0;
});

describe("provisioning a user from a service token naming a wallet", () => {
  test("stores the address but never claims the wallet was verified", async () => {
    const result = await authenticateWaifuBridge(await bridgeRequest(`waifu:${VICTIM_WALLET}`));

    expect(result?.authMethod).toBe("service_jwt");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].wallet_address).toBe(VICTIM_WALLET.toLowerCase());
    // The whole point: nothing in this chain verified a signature over that
    // address, so the flag the OIDC identity gate reads must stay false.
    expect(createCalls[0].wallet_verified).toBe(false);
  });

  test("a token with no wallet in its subject provisions no wallet at all", async () => {
    await authenticateWaifuBridge(await bridgeRequest("waifu-service-account"));

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].wallet_address).toBeUndefined();
    expect(createCalls[0].wallet_verified).toBe(false);
  });
});

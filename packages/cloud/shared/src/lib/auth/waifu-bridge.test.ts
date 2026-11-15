/**
 * A waifu-core service token names an account by convention. Resolving it must
 * not rewrite that account's Steward identity, and must not let a deactivated
 * user or organization through the compat routes.
 */
import { afterEach, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";
process.env.ELIZA_SERVICE_JWT_SECRET = "waifu-bridge-test-secret-0123456789abcdef";

const { SignJWT } = await import("jose");
const { dbWrite } = await import("../../db/helpers");
const { ForbiddenError } = await import("../api/errors");
const { usersService } = await import("../services/users");
const { authenticateWaifuBridge } = await import("./waifu-bridge");

type BridgeUser = NonNullable<Awaited<ReturnType<typeof usersService.getByStewardId>>>;

const WALLET = "0x1111111111111111111111111111111111111111";
const stewardUser = {
  id: "user-real",
  steward_user_id: "steward-real-subject",
  organization_id: "org-real",
  wallet_address: WALLET,
  is_active: true,
  organization: { id: "org-real", is_active: true },
} as unknown as BridgeUser;

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function bridgeRequest(userId: string): Promise<Request> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(process.env.ELIZA_SERVICE_JWT_SECRET));
  return new Request("https://cloud.test/api/compat/agents", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function resolves(input: { byService?: BridgeUser; byWallet?: BridgeUser }) {
  spies.push(spyOn(usersService, "getByStewardId").mockResolvedValue(input.byService));
  spies.push(
    spyOn(usersService, "getByWalletAddressWithOrganization").mockResolvedValue(input.byWallet),
  );
  const insert = spyOn(dbWrite, "insert");
  spies.push(insert);
  return insert;
}

test("a wallet match on a real Steward user keeps its Steward identity", async () => {
  const insert = resolves({ byWallet: stewardUser });
  const result = await authenticateWaifuBridge(await bridgeRequest(`waifu:${WALLET}`));
  expect(result?.user.id).toBe("user-real");
  expect(result?.user.steward_user_id).toBe("steward-real-subject");
  expect(insert).not.toHaveBeenCalled();
});

test("a deactivated wallet-matched user is refused", async () => {
  resolves({ byWallet: { ...stewardUser, is_active: false } as BridgeUser });
  await expect(authenticateWaifuBridge(await bridgeRequest(`waifu:${WALLET}`))).rejects.toThrow(
    ForbiddenError,
  );
});

test("a service user in a deactivated organization is refused", async () => {
  resolves({
    byService: {
      ...stewardUser,
      steward_user_id: "svc_waifu_svc",
      organization: { id: "org-real", is_active: false },
    } as BridgeUser,
  });
  await expect(authenticateWaifuBridge(await bridgeRequest("waifu:svc"))).rejects.toThrow(
    ForbiddenError,
  );
});

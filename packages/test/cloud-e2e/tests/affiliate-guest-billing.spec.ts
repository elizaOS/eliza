import { randomUUID } from "node:crypto";
import { expect, test } from "../src/helpers/test-fixtures";

/**
 * Affiliate (application) guest-session attribution contract.
 *
 * Grounded on the shipped change "bill affiliate guest sessions to the
 * application owner's credits" (commit 25be60a0d2,
 * affiliate/create-character/route.ts):
 *   • POST /api/affiliate/create-character authenticates an API key carrying the
 *     `affiliate:create-character` permission (route.ts:31,106-135).
 *   • The guest user + character are created INSIDE the API-key OWNER's org
 *     (resolveApplicationOwnerOrg uses apiKey.organization_id), not a shared
 *     `affiliate-characters` pool — route.ts:149-157,224-236,283-326. The guest
 *     user is is_anonymous (route.ts:234) and the character records
 *     sponsorOrganizationId = the owner org (route.ts:312).
 *
 * SCOPE JUDGMENT CALL: the brief asked to "drive a billable action -> owner
 * credit_balance decreased AND an app_owner_revenue_share redeemable-earnings
 * ledger entry was written." That does not match the implementation: the commit
 * does NOT bill or write any ledger entry — character creation is explicitly
 * balance-agnostic, and `app_owner_revenue_share` is only ever written from
 * credit PURCHASE splits (topup-handler.ts:439, crypto-payments.ts:1068,
 * src/queue/stripe-event.ts:296), never from a guest inference path (which uses
 * the "affiliate" earnings source — ai-billing.ts:256-269). Guest inference
 * billing is also unreachable keyless (needs a live model + reserved credits).
 * So this spec asserts the real, verifiable attribution behavior the change
 * shipped: the guest lands in the OWNER's org as an anonymous user, and no
 * magic shared affiliate pool is created.
 */

const AFFILIATE_PERMISSION = "affiliate:create-character";

async function mintAffiliateKey(
  organizationId: string,
  userId: string,
): Promise<string> {
  const { apiKeysService } = await import(
    "@elizaos/cloud-shared/lib/services/api-keys"
  );
  const { plainKey } = await apiKeysService.create({
    name: "cloud-e2e-affiliate",
    description: "cloud-e2e affiliate key",
    organization_id: organizationId,
    user_id: userId,
    permissions: ["read", AFFILIATE_PERMISSION],
    rate_limit: 10_000,
    is_active: true,
  });
  return plainKey;
}

test.describe("affiliate guest session attribution", () => {
  test("guest character + user land in the application owner's org", async ({
    stack,
    seededUser,
  }) => {
    const affiliateKey = await mintAffiliateKey(
      seededUser.organizationId,
      seededUser.userId,
    );
    const affiliateId = `app-${randomUUID().slice(0, 8)}`;

    const res = await fetch(
      `${stack.urls.api}/api/affiliate/create-character`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${affiliateKey}`,
          "Content-Type": "application/json",
          Origin: stack.urls.api,
        },
        body: JSON.stringify({
          character: {
            name: "Guest Crush",
            bio: "An affiliate guest character.",
          },
          affiliateId,
          metadata: { source: "e2e" },
        }),
      },
    );
    expect(
      res.status,
      `create-character returned ${res.status}: ${await res.clone().text()}`,
    ).toBe(201);
    const body = (await res.json()) as {
      success?: boolean;
      characterId?: string;
      sessionId?: string;
    };
    expect(body.success).toBe(true);
    expect(body.characterId, "expected a created character id").toBeTruthy();
    expect(body.sessionId, "expected a session id").toBeTruthy();

    const characterId = body.characterId as string;

    // The character was created inside the OWNER's organization.
    const { userCharactersRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/characters"
    );
    const character = await userCharactersRepository.findById(characterId);
    expect(character, `expected character ${characterId}`).toBeTruthy();
    expect(character?.organization_id).toBe(seededUser.organizationId);

    // It records the sponsoring (owner) organization in its affiliate metadata.
    const charData = character?.character_data as
      | { affiliate?: { sponsorOrganizationId?: string; affiliateId?: string } }
      | undefined;
    expect(charData?.affiliate?.sponsorOrganizationId).toBe(
      seededUser.organizationId,
    );
    expect(charData?.affiliate?.affiliateId).toBe(affiliateId);

    // The guest user owning the character is an anonymous user in the owner org.
    const guestUserId = character?.user_id;
    expect(
      guestUserId,
      "expected character to have an owner user",
    ).toBeTruthy();
    const { usersService } = await import(
      "@elizaos/cloud-shared/lib/services/users"
    );
    const guestUser = await usersService.getById(guestUserId as string);
    expect(guestUser, `expected guest user ${guestUserId}`).toBeTruthy();
    expect(guestUser?.organization_id).toBe(seededUser.organizationId);
    expect(guestUser?.is_anonymous).toBe(true);
    expect(guestUser?.id).not.toBe(seededUser.userId);

    // The legacy shared "affiliate-characters" pool org is NOT created anymore.
    const { organizationsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/organizations"
    );
    const legacyPool = await organizationsRepository.findBySlug(
      "affiliate-characters",
    );
    expect(
      legacyPool,
      "the magic shared affiliate-characters pool must not exist",
    ).toBeFalsy();
  });

  test("the key's affiliate permission is required", async ({
    stack,
    seededUser,
  }) => {
    // The default seeded key has read/write/admin but NOT
    // affiliate:create-character, so it must be forbidden.
    const res = await fetch(
      `${stack.urls.api}/api/affiliate/create-character`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${seededUser.apiKey}`,
          "Content-Type": "application/json",
          Origin: stack.urls.api,
        },
        body: JSON.stringify({
          character: { name: "Nope", bio: "no permission" },
          affiliateId: "denied",
        }),
      },
    );
    expect(
      res.status,
      `non-affiliate key should be forbidden, got ${res.status}`,
    ).toBe(403);
  });
});

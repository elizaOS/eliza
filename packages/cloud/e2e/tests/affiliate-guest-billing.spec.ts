/** Covers the affiliate guest billing cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import { randomUUID } from "node:crypto";
import { expect, test } from "../src/helpers/test-fixtures";

/**
 * Affiliate (application) guest-session attribution contract.
 *
 * Grounded on the shipped change "bill affiliate guest sessions to the
 * application owner's credits" (affiliate/create-character/route.ts):
 *   • POST /api/affiliate/create-character authenticates ANY valid, active API
 *     key (a key is just a key — full access; route.ts:106-130).
 *   • The guest user + character are created INSIDE the API-key OWNER's org
 *     (resolveApplicationOwnerOrg uses apiKey.organization_id), not a shared
 *     `affiliate-characters` pool. The guest user is is_anonymous and the
 *     character records sponsorOrganizationId = the owner org.
 *
 * Asserts the real attribution behavior: the guest lands in the OWNER's org as
 * an anonymous user, no magic shared affiliate pool is created, and the route
 * still rejects a request with no valid key.
 */

test.describe("affiliate guest session attribution", () => {
  test("guest character + user land in the application owner's org", async ({
    stack,
    seededUser,
  }) => {
    // Any valid, active key for the owner's org works (no per-key scopes).
    const affiliateKey = seededUser.apiKey;
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

  test("a request without a valid API key is rejected", async ({ stack }) => {
    const res = await fetch(
      `${stack.urls.api}/api/affiliate/create-character`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer not-a-real-key",
          "Content-Type": "application/json",
          Origin: stack.urls.api,
        },
        body: JSON.stringify({
          character: { name: "Nope", bio: "no key" },
          affiliateId: "denied",
        }),
      },
    );
    expect(
      [401, 403],
      `invalid key should be rejected, got ${res.status}`,
    ).toContain(res.status);
  });
});

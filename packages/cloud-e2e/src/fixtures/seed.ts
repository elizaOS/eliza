/**
 * Seed helpers for the cloud E2E DB.
 *
 * Mirrors `packages/cloud-api/test/e2e/preload.ts` but is callable on demand
 * from a Playwright fixture instead of via bun's `--preload`. Reuses the
 * cloud-shared repositories so we don't reimplement schema knowledge.
 */

import { randomUUID } from "node:crypto";

export interface SeededUser {
  userId: string;
  organizationId: string;
  stewardUserId: string;
  email: string;
  apiKey: string;
}

export interface SeedTestUserOptions {
  slug?: string;
  email?: string;
  stewardUserId?: string;
  role?: string;
}

/**
 * Insert a fully-set-up test user + org + API key.
 *
 * Dynamically imports cloud-shared at call time so the seed module doesn't
 * pull DB connections in at fixture-import time. The caller is responsible
 * for ensuring DATABASE_URL points at the running PGlite bridge before
 * invoking this.
 */
export async function seedTestUser(
  opts: SeedTestUserOptions = {},
): Promise<SeededUser> {
  const slug = opts.slug ?? `e2e-${randomUUID().slice(0, 8)}`;
  const email = opts.email ?? `${slug}@e2e.test`;
  const stewardUserId = opts.stewardUserId ?? `steward-${slug}`;
  const role = opts.role ?? "admin";

  const { dbWrite } = await import("@elizaos/cloud-shared/db/helpers");
  const { organizations } = await import(
    "@elizaos/cloud-shared/db/schemas/organizations"
  );
  const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
  const { usersRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/users"
  );
  const { apiKeysService } = await import(
    "@elizaos/cloud-shared/lib/services/api-keys"
  );

  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: slug,
      slug,
      billing_email: email,
      credit_balance: "1000.000000",
    })
    .returning();

  const [user] = await dbWrite
    .insert(users)
    .values({
      email,
      email_verified: true,
      name: slug,
      organization_id: organization.id,
      role,
      steward_user_id: stewardUserId,
      wallet_address: `0x${randomUUID().replaceAll("-", "").slice(0, 40)}`,
      wallet_chain_type: "evm",
      wallet_verified: true,
    })
    .returning();

  await usersRepository.upsertStewardIdentity(user.id, stewardUserId);

  const { plainKey } = await apiKeysService.create({
    name: "cloud-e2e",
    description: "cloud-e2e harness key",
    organization_id: organization.id,
    user_id: user.id,
    permissions: ["read", "write", "admin"],
    rate_limit: 10_000,
    is_active: true,
  });

  return {
    userId: user.id,
    organizationId: organization.id,
    stewardUserId,
    email,
    apiKey: plainKey,
  };
}

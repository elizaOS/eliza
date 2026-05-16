/**
 * Worker-targeted e2e preload.
 *
 * Mirrors `cloud/packages/tests/e2e/preload.ts` but does NOT boot the legacy
 * Next.js dev server — the Worker-targeted suite expects an already-running
 * Worker (typically `wrangler dev` on :8787) and just needs:
 *
 *   1. Env loaded from .env / .env.local / .env.test.
 *   2. Local Postgres seeded with the test org/user/api-key, which exports
 *      TEST_API_KEY into process.env.
 *
 * Run with: bun test --preload <this-file> apps/api/test/e2e
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { dbWrite } from "@elizaos/cloud-shared/db/helpers";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { usersRepository } from "@elizaos/cloud-shared/db/repositories/users";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import { apiKeysService } from "@elizaos/cloud-shared/lib/services/api-keys";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";

for (const envPath of [
  resolve("../../.env"),
  resolve("../../.env.local"),
  resolve("../../.env.test"),
]) {
  config({ path: envPath });
}

const DEFAULT_TEST_SECRETS_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
function testWalletAddress(seed: string): string {
  const digest = createHash("sha256")
    .update(`playwright:${seed}`)
    .digest("hex");
  return privateKeyToAccount(`0x${digest}`).address;
}

if (!process.env.SECRETS_MASTER_KEY) {
  process.env.SECRETS_MASTER_KEY = DEFAULT_TEST_SECRETS_MASTER_KEY;
}

process.env.CRON_SECRET ??= "test-cron-secret";
process.env.INTERNAL_SECRET ??= "test-internal-secret";
process.env.AGENT_TEST_BOOTSTRAP_ADMIN ??= "true";
process.env.PLAYWRIGHT_TEST_AUTH ??= "true";
process.env.PLAYWRIGHT_TEST_AUTH_SECRET ??= "playwright-local-auth-secret";
process.env.PAYOUT_STATUS_SKIP_LIVE_BALANCE ??= "1";

if (process.env.SKIP_DB_DEPENDENT === "1") {
  throw new Error(
    "Worker e2e requires a bootstrapped test database; unset SKIP_DB_DEPENDENT.",
  );
}

async function ensureTestUser({
  slug,
  email,
  stewardUserId,
  role = "admin",
}: {
  slug: string;
  email: string;
  stewardUserId: string;
  role?: string;
}) {
  const walletAddress = testWalletAddress(stewardUserId);
  const existingOrg = await dbWrite.query.organizations.findFirst({
    where: eq(organizations.slug, slug),
  });
  const organization =
    existingOrg ??
    (
      await dbWrite
        .insert(organizations)
        .values({
          name: slug,
          slug,
          billing_email: email,
          credit_balance: "1000.000000",
        })
        .returning()
    )[0];

  const existingUser = await dbWrite.query.users.findFirst({
    where: eq(users.steward_user_id, stewardUserId),
  });
  const user =
    existingUser ??
    (
      await dbWrite
        .insert(users)
        .values({
          email,
          email_verified: true,
          name: slug,
          organization_id: organization.id,
          role,
          steward_user_id: stewardUserId,
          wallet_address: walletAddress,
          wallet_chain_type: "evm",
          wallet_verified: true,
        })
        .returning()
    )[0];

  await dbWrite
    .update(organizations)
    .set({
      credit_balance: "1000.000000",
      is_active: true,
      updated_at: new Date(),
    })
    .where(eq(organizations.id, organization.id));
  await dbWrite
    .update(users)
    .set({
      email,
      organization_id: organization.id,
      role,
      wallet_address: walletAddress,
      wallet_chain_type: "evm",
      wallet_verified: true,
      is_active: true,
      updated_at: new Date(),
    })
    .where(eq(users.id, user.id));
  await usersRepository.upsertStewardIdentity(user.id, stewardUserId);

  const sandboxes = await agentSandboxesRepository.listByOrganization(
    organization.id,
  );
  if (sandboxes.length === 0) {
    await agentSandboxesRepository.create({
      organization_id: organization.id,
      user_id: user.id,
      sandbox_id: `${slug}-sandbox`,
      status: "running",
      agent_name: `${slug} test agent`,
      bridge_url: "http://127.0.0.1:65535",
      health_url: "http://127.0.0.1:65535/health",
      database_status: "ready",
      environment_vars: {},
    });
  }

  await apiKeysService.deactivateUserKeysByName(user.id, "playwright-e2e");
  const { plainKey } = await apiKeysService.create({
    name: "playwright-e2e",
    description: "Local cloud API e2e test key",
    organization_id: organization.id,
    user_id: user.id,
    permissions: ["read", "write", "admin"],
    rate_limit: 10_000,
    is_active: true,
  });

  return { organization, user, plainKey };
}

const owner = await ensureTestUser({
  slug: "playwright-e2e-org",
  email: "playwright-owner@elizalabs.ai",
  stewardUserId: "playwright-e2e-owner",
  role: "admin",
});
const member = await ensureTestUser({
  slug: "playwright-e2e-member-org",
  email: "playwright-member@example.test",
  stewardUserId: "playwright-e2e-member",
  role: "member",
});

process.env.TEST_API_KEY = owner.plainKey;
process.env.TEST_MEMBER_API_KEY = member.plainKey;
process.env.TEST_AFFILIATE_API_KEY = owner.plainKey;
process.env.TEST_USER_ID = owner.user.id;
process.env.TEST_USER_EMAIL =
  owner.user.email ?? "playwright-owner@example.test";
process.env.TEST_ORGANIZATION_ID = owner.organization.id;

if (process.env.REQUIRE_E2E_SERVER !== "0") {
  const baseUrl =
    process.env.TEST_API_BASE_URL?.trim() ||
    process.env.TEST_BASE_URL?.trim() ||
    "http://localhost:8787";
  const response = await fetch(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `Worker e2e target is not healthy: GET ${baseUrl}/api/health -> ${response.status}`,
    );
  }
}

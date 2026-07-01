/**
 * Real wallet (SIWE) login for cloud E2E.
 *
 * `seedTestUser` (fixtures/seed.ts) inserts org/user/api-key rows directly — fast,
 * but it never exercises the login flow. `loginWithTestWallet` instead drives the
 * genuine EIP-4361 handshake against the booted cloud-api (nonce → sign → verify),
 * so a spec proves the REAL login path works end-to-end and gets back a real API
 * key for a free account. The cloud-e2e stack runs the worker with `MOCK_REDIS=1`
 * (shared in-process store), so the SIWE nonce survives between the two requests.
 */

import {
  type SiweTestLoginResult,
  siweTestLogin,
} from "@elizaos/cloud-shared/lib/auth/siwe-test-login";
import type { SeededUser } from "../fixtures/seed";

export type { SiweTestLoginResult };

/**
 * Perform the real SIWE login against the booted stack's cloud-api `baseUrl`.
 * Pass a `privateKey` to sign in as the same wallet across runs; omit it for a
 * fresh free account.
 */
export async function loginWithTestWallet(
  baseUrl: string,
  privateKey?: `0x${string}`,
): Promise<SiweTestLoginResult> {
  return siweTestLogin({ baseUrl, privateKey });
}

/**
 * Adapt a wallet login to the `SeededUser` shape so specs/fixtures already built
 * around `seedTestUser` can switch to the real login path with no other changes.
 * SIWE accounts are wallet-only, so `email` is empty and `stewardUserId` is
 * derived from the address.
 */
export function asSeededUser(login: SiweTestLoginResult): SeededUser {
  return {
    userId: login.userId,
    organizationId: login.organizationId,
    stewardUserId: `wallet-${login.address.toLowerCase()}`,
    email: "",
    apiKey: login.apiKey,
  };
}

/**
 * Privileged baseline the cloud-e2e suite assumes for its primary identity:
 * an `admin` of a funded org with a known, verified email. `seedTestUser`
 * produced exactly this end-state by inserting rows directly; here we instead
 * reach it through the REAL login path and then elevate.
 */
const SEEDED_BASELINE_CREDIT_BALANCE = "1000.000000";
const SEEDED_BASELINE_ROLE = "admin";

/**
 * Drive the genuine SIWE handshake and return a `SeededUser` that is a drop-in
 * replacement for `seedTestUser()`.
 *
 * The API key, user, and organization are all minted by the REAL login flow
 * (nonce → sign → verify → find-or-create wallet account). The only thing we
 * add on top is the privileged baseline the suite's specs depend on — admin
 * role, a funded credit balance, and a known verified email — applied with a
 * direct DB write, exactly as `seedTestUser` did. So every spec that consumes
 * the `seededUser` fixture now authenticates with a credential produced by the
 * real login path, while its role/credit assumptions stay intact.
 *
 * The caller must have `DATABASE_URL` pointed at the running PGlite bridge (the
 * cloud-e2e `stack` fixture guarantees this), since the elevation writes to the
 * same DB the booted worker just created the account in.
 */
export async function loginAsSeededUser(
  baseUrl: string,
  privateKey?: `0x${string}`,
): Promise<SeededUser> {
  const login = await siweTestLogin({ baseUrl, privateKey });

  const normalizedAddress = login.address.toLowerCase();
  const email = `${normalizedAddress}@e2e.test`;
  const name = `wallet-${normalizedAddress.slice(2, 10)}`;

  // Reuse the cloud-shared repositories (same DB connection + drizzle instance)
  // so we don't reimplement schema knowledge or risk a duplicate drizzle copy.
  const { usersRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/users"
  );
  const { organizationsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/organizations"
  );

  await usersRepository.update(login.userId, {
    email,
    email_verified: true,
    name,
    role: SEEDED_BASELINE_ROLE,
  });

  await organizationsRepository.update(login.organizationId, {
    credit_balance: SEEDED_BASELINE_CREDIT_BALANCE,
    billing_email: email,
  });

  return {
    userId: login.userId,
    organizationId: login.organizationId,
    stewardUserId: `wallet:evm:${normalizedAddress}`,
    email,
    apiKey: login.apiKey,
  };
}

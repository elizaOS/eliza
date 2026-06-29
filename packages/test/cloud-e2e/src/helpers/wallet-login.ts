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

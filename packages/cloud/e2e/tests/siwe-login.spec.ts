/** Covers the siwe login cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import { expect, test } from "../src/helpers/test-fixtures";
import { loginWithTestWallet } from "../src/helpers/wallet-login";

/**
 * Proves the REAL wallet sign-in path works end-to-end against the booted
 * cloud-api — the gap `seedTestUser` (direct DB insert) never covered.
 *
 * Every assertion runs the genuine EIP-4361 handshake: `GET /api/auth/siwe/nonce`
 * → build + sign the message with a throwaway viem wallet → `POST
 * /api/auth/siwe/verify`. The server re-validates signature + nonce + domain via
 * the same `validateAndConsumeSIWE` production uses, so a green run here means the
 * login crypto, nonce single-use, and find-or-create wallet account all work.
 */
test.describe("SIWE wallet login (real handshake)", () => {
  const BALANCE = "/api/v1/credits/balance";

  test("nonce → sign → verify mints a real API key for a fresh free account", async ({
    stack,
  }) => {
    const login = await loginWithTestWallet(stack.urls.api);

    expect(login.apiKey, "verify must return a real API key").toMatch(
      /^eliza_/,
    );
    expect(login.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(login.userId, "login must resolve a user id").toBeTruthy();
    expect(
      login.organizationId,
      "login must resolve an organization id",
    ).toBeTruthy();
    expect(
      login.isNewAccount,
      "a fresh throwaway wallet must create a new account",
    ).toBe(true);

    // The credential the login minted authorizes a real authed request — this
    // is the whole point: the key is usable, not a dead string.
    const res = await fetch(`${stack.urls.api}${BALANCE}`, {
      headers: { Authorization: `Bearer ${login.apiKey}` },
    });
    expect(
      res.status,
      `authed balance probe with the minted key: ${res.status}: ${await res.clone().text()}`,
    ).toBe(200);
  });

  test("a present-but-forged signature is rejected (no key issued)", async ({
    stack,
  }) => {
    const res = await fetch(`${stack.urls.api}/api/auth/siwe/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "I am definitely not a valid EIP-4361 message",
        signature: "0xdeadbeef",
      }),
    });
    expect(
      res.status,
      `forged verify must be rejected, got ${res.status}: ${await res.clone().text()}`,
    ).toBe(401);
  });

  test("signing in again with the same wallet returns the same account", async ({
    stack,
  }) => {
    const first = await loginWithTestWallet(stack.urls.api);
    // Reuse the first login's private key → the find-or-create path must return
    // the existing account (a real second login, not a new signup).
    const second = await loginWithTestWallet(stack.urls.api, first.privateKey);

    expect(second.address).toBe(first.address);
    expect(second.userId).toBe(first.userId);
    expect(second.organizationId).toBe(first.organizationId);
    expect(first.isNewAccount).toBe(true);
    expect(
      second.isNewAccount,
      "the second sign-in must resolve the existing account, not create one",
    ).toBe(false);
  });

  test("the seededUser fixture identity is itself minted by the real login path", async ({
    stack,
    seededUser,
  }) => {
    // seededUser now comes from loginAsSeededUser (real handshake → elevate).
    // Its key must authorize the admin-scoped members endpoint and resolve to
    // the elevated identity.
    const res = await fetch(`${stack.urls.api}/api/organizations/members`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect(
      res.status,
      `members with fixture key: ${res.status}: ${await res.clone().text()}`,
    ).toBe(200);
    const body = (await res.json()) as {
      data?: Array<{ id: string; email: string | null; role: string | null }>;
    };
    const self = body.data?.find((m) => m.id === seededUser.userId);
    expect(self, "fixture identity must appear in its org").toBeTruthy();
    expect(self?.role).toBe("admin");
    expect(self?.email).toBe(seededUser.email);
  });
});

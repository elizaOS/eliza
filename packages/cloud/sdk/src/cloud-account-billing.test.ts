// Credential-bound account billing reader: plan fallback and credit state from the billing
// snapshot, entitlement reads, idempotent redemption and self-revocation. Synthetic data only.
import { describe, expect, test } from "bun:test";
import {
  CloudAccountBillingClient,
  type CloudAccountBillingPorts,
  type CloudBillingCredential,
  CloudBillingError,
  type CloudBillingRequest,
  type CloudBillingResponse,
  CURRENT_API_KEY_PATH,
} from "./cloud-account-billing.js";
import {
  BILLING_LIMITS_PATH,
  checkEntitlement,
  ENTITLEMENT_KEYS_PATH,
  ENTITLEMENT_PATH,
  REDEEM_PATH,
  SubscriptionRedeemError,
} from "./subscription-entitlement.js";

const NOW = 1_800_000_000_000;
const CODE = "ABCD-EFGH-JKMN-PQRS";
const KEY = "redeem-0001-synthetic";

function limits(
  balance: string | null,
  subscription: unknown = {
    status: "not_applicable",
    reason: "no_organization_subscription",
  },
) {
  return {
    success: true,
    data: {
      schemaVersion: 2,
      v2: {
        subscription,
        ...(balance === null
          ? {}
          : {
              balance: {
                status: "available",
                source: "organizations",
                observedAt: new Date(NOW - 1000).toISOString(),
                value: {
                  balance: { value: balance, unit: "usd", currency: "USD" },
                  revision: "7",
                },
              },
            }),
      },
    },
  };
}

function harness(
  answer: (
    input: CloudBillingRequest,
    calls: CloudBillingRequest[],
  ) => Promise<CloudBillingResponse> | CloudBillingResponse,
  extra: Partial<CloudAccountBillingPorts> = {},
) {
  const calls: CloudBillingRequest[] = [];
  const state = {
    credential: {
      credentialId: "cred-a",
      token: "secret-a",
      userId: "user-a",
    } as CloudBillingCredential | null,
  };
  const client = new CloudAccountBillingClient({
    readCredential: async () => state.credential,
    request: async (input) => {
      calls.push(input);
      return answer(input, calls);
    },
    delay: async () => {},
    now: () => NOW,
    ...extra,
  });
  return { client, calls, state };
}
const signal = () => new AbortController().signal;
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CloudBillingError ||
      error instanceof SubscriptionRedeemError
      ? error.code
      : String(error);
  }
  return "resolved";
};

describe("billing snapshot reads", () => {
  test("credit state renders zero as zero and funded as funded, bound to the presented credential", async () => {
    const zero = harness(() => ({ status: 200, data: limits("0") }));
    expect(await zero.client.credits(signal())).toEqual({
      state: "zero",
      usd: "0",
      observedAt: NOW - 1000,
    });
    expect(zero.calls).toEqual([
      expect.objectContaining({
        path: BILLING_LIMITS_PATH,
        method: "GET",
        credential: zero.state.credential,
      }),
    ]);
    const funded = harness(() => ({ status: 200, data: limits("12.50") }));
    expect((await funded.client.credits(signal())).state).toBe("funded");
    const missing = harness(() => ({ status: 200, data: limits(null) }));
    expect((await missing.client.credits(signal())).state).toBe("unavailable");
  });

  test("an account change during a read is refused rather than shown", async () => {
    const swapped = harness(() => {
      swapped.state.credential = { credentialId: "cred-b", token: "secret-b" };
      return { status: 200, data: limits("9") };
    });
    expect(await code(swapped.client.credits(signal()))).toBe(
      "account-changed",
    );
    // The same generation re-signed for another user is a different account for credits.
    const rebound = harness(() => {
      rebound.state.credential = {
        credentialId: "cred-a",
        token: "secret-a",
        userId: "user-b",
      };
      return { status: 200, data: limits("9") };
    });
    expect(await code(rebound.client.credits(signal()))).toBe(
      "account-changed",
    );
    const plan = harness(() => {
      plan.state.credential = null;
      return { status: 200, data: limits("0") };
    });
    expect(await code(plan.client.fallbackPlan(signal()))).toBe(
      "account-changed",
    );
  });

  test("a missing or expired sign-in sends nothing", async () => {
    const signedOut = harness(() => ({ status: 200, data: {} }));
    signedOut.state.credential = null;
    expect(await code(signedOut.client.credits(signal()))).toBe(
      "credentials-missing",
    );
    signedOut.state.credential = { credentialId: "cred-a", expiresAt: NOW };
    expect(await code(signedOut.client.fallbackPlan(signal()))).toBe("expired");
    expect(signedOut.calls).toEqual([]);
  });

  test("plan fallback reads the snapshot's subscription and treats an absent route as unknown", async () => {
    const credits = harness(() => ({ status: 200, data: limits("0") }));
    expect(await credits.client.fallbackPlan(signal())).toEqual({
      status: "none",
      planName: null,
      periodEnd: null,
      billingMode: "organization-credits",
    });
    const active = harness(() => ({
      status: 200,
      data: limits(null, {
        status: "available",
        value: {
          planKey: "plus_monthly",
          state: "active",
          currentPeriodEnd: "2099-01-01T00:00:00.000Z",
        },
      }),
    }));
    expect(await active.client.fallbackPlan(signal())).toMatchObject({
      status: "active",
      planName: "Plus",
    });
    for (const status of [404, 405, 501])
      expect(
        await harness(() => ({ status, data: {} })).client.fallbackPlan(
          signal(),
        ),
      ).toBeNull();
    expect(
      await harness(() => ({
        status: 200,
        data: { success: false },
      })).client.fallbackPlan(signal()),
    ).toBeNull();
    const refused = harness(() => ({ status: 401, data: {} }));
    const error = await refused.client
      .fallbackPlan(signal())
      .catch((value) => value);
    expect(error).toBeInstanceOf(CloudBillingError);
    expect(error).toMatchObject({ code: "http", status: 401 });
    expect(
      await code(
        harness(() => ({
          status: 503,
          data: {},
          retryAfter: "30",
        })).client.credits(signal()),
      ),
    ).toBe("http");
    expect(
      await code(
        harness(() => ({ status: 200, data: [] })).client.credits(signal()),
      ),
    ).toBe("invalid-response");
  });
});

describe("entitlement reads", () => {
  test("binds the entitlement to the credential and treats an absent route as not published", async () => {
    const signed = harness((input) => ({
      status: 200,
      data:
        input.path === ENTITLEMENT_PATH
          ? { entitlement: "a.b.c" }
          : { keys: [] },
    }));
    expect(await signed.client.entitlement(signal())).toBe("a.b.c");
    expect(await signed.client.entitlementKeys(signal())).toEqual([]);
    expect(
      signed.calls.map((call) => [
        call.path,
        call.credential?.credentialId ?? null,
      ]),
    ).toEqual([
      [ENTITLEMENT_PATH, "cred-a"],
      [ENTITLEMENT_KEYS_PATH, null],
    ]);
    expect(
      await harness(() => ({ status: 404, data: {} })).client.entitlement(
        signal(),
      ),
    ).toBeNull();
    expect(
      await code(
        harness(() => ({
          status: 200,
          data: { entitlement: 3 },
        })).client.entitlement(signal()),
      ),
    ).toBe("invalid-response");
    expect(
      await code(
        harness(() => ({
          status: 200,
          data: { keys: "none" },
        })).client.entitlementKeys(signal()),
      ),
    ).toBe("invalid-response");
  });

  test("feeds checkEntitlement with the billing snapshot fallback when the route is absent", async () => {
    const absent = harness((input) =>
      input.path === BILLING_LIMITS_PATH
        ? {
            status: 200,
            data: limits("0", {
              status: "available",
              value: {
                planKey: "plus_monthly",
                state: "active",
                currentPeriodEnd: "2099-01-01T00:00:00.000Z",
              },
            }),
          }
        : { status: 404, data: {} },
    );
    const checked = await checkEntitlement(
      absent.client.entitlementSource("https://api.example.invalid"),
      { userId: "user-a", organizationId: null },
      signal(),
    );
    expect(checked.view).toMatchObject({
      kind: "active",
      source: "billing-limits",
    });
  });
});

describe("redemption", () => {
  test("normalizes the code, sends one keyed request and reads the grant", async () => {
    const ok = harness(() => ({
      status: 200,
      data: {
        success: true,
        replayed: false,
        grant: { endsAt: "2099-01-01T00:00:00.000Z" },
      },
    }));
    expect(
      await ok.client.redeem(CODE.toLowerCase(), KEY, signal()),
    ).toMatchObject({
      replayed: false,
      grantEndsAt: Date.parse("2099-01-01T00:00:00.000Z"),
    });
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]).toMatchObject({
      path: REDEEM_PATH,
      method: "POST",
      body: { code: "ABCDEFGHJKMNPQRS", idempotencyKey: KEY },
    });
    expect(await code(ok.client.redeem("nope", KEY, signal()))).toBe("invalid");
    expect(await code(ok.client.redeem(CODE, "short", signal()))).toBe(
      "TypeError: Invalid idempotency key",
    );
    expect(ok.calls).toHaveLength(1);
  });

  test("replays a transport failure once with the same key and never retries a refusal", async () => {
    let failures = 1;
    const lost = harness(() => {
      if (failures-- > 0) throw new Error("Connection request failed");
      return {
        status: 200,
        data: { success: true, replayed: true, grant: {} },
      };
    });
    expect((await lost.client.redeem(CODE, KEY, signal())).replayed).toBe(true);
    expect(
      lost.calls.map(
        (call) => (call.body as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual([KEY, KEY]);
    const twice = harness(() => {
      throw new Error("Connection request failed");
    });
    expect(await code(twice.client.redeem(CODE, KEY, signal()))).toBe(
      "unavailable",
    );
    expect(twice.calls).toHaveLength(2);
    const changed = harness(
      () => {
        throw new Error("Cloud account changed");
      },
      {
        replayable: (error) =>
          !(
            error instanceof Error && error.message === "Cloud account changed"
          ),
      },
    );
    expect(await code(changed.client.redeem(CODE, KEY, signal()))).toBe(
      "Error: Cloud account changed",
    );
    expect(changed.calls).toHaveLength(1);
    for (const [status, expected] of [
      [400, "invalid"],
      [403, "account"],
      [429, "rate-limited"],
      [500, "unavailable"],
      [401, "http"],
    ] as const) {
      const refused = harness(() => ({ status, data: {}, retryAfter: "60" }));
      expect(await code(refused.client.redeem(CODE, KEY, signal()))).toBe(
        expected,
      );
      expect(refused.calls).toHaveLength(1);
    }
  });

  test("a grant that lands after the account changed is not applied", async () => {
    const swapped = harness(() => {
      swapped.state.credential = { credentialId: "cred-b" };
      return {
        status: 200,
        data: { success: true, replayed: false, grant: {} },
      };
    });
    expect(await code(swapped.client.redeem(CODE, KEY, signal()))).toBe(
      "account-changed",
    );
  });
});

describe("self-revocation", () => {
  test("revokes the presented key once and reports what Cloud confirmed", async () => {
    const revoked = harness(
      () => ({
        status: 200,
        data: {
          success: true,
          status: "revoked",
          credentialId: "srv-1",
          revokedAt: "2026-10-28T00:00:00.000Z",
        },
      }),
      { deleteRequests: true },
    );
    const credential = { credentialId: "cred-a", token: "secret-a" };
    expect(await revoked.client.revoke(credential, signal())).toEqual({
      supported: true,
      revoked: true,
      credentialId: "srv-1",
      revokedAt: "2026-10-28T00:00:00.000Z",
    });
    expect(revoked.calls).toEqual([
      expect.objectContaining({
        path: CURRENT_API_KEY_PATH,
        method: "DELETE",
        credential,
      }),
    ]);
    expect(
      await harness(() => ({ status: 404, data: {} }), {
        deleteRequests: true,
      }).client.revoke(credential, signal()),
    ).toEqual({ supported: false, reason: "server" });
    const noDelete = harness(() => ({ status: 200, data: {} }));
    expect(await noDelete.client.revoke(credential, signal())).toEqual({
      supported: false,
      reason: "transport",
    });
    expect(await noDelete.client.revoke(null, signal())).toEqual({
      supported: false,
      reason: "no-credential",
    });
    expect(noDelete.calls).toEqual([]);
    expect(
      await code(
        harness(
          () => ({ status: 200, data: { success: true, status: "pending" } }),
          { deleteRequests: true },
        ).client.revoke(credential, signal()),
      ),
    ).toBe("invalid-response");
    expect(
      await code(
        harness(() => ({ status: 401, data: {} }), {
          deleteRequests: true,
        }).client.revoke(credential, signal()),
      ),
    ).toBe("http");
  });
});

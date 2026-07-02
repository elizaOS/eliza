/**
 * Least-privilege guard for per-app API keys (#10852).
 *
 * App-minted keys are full org credentials with no scope column, so without this
 * guard App A's key can DELETE/rotate/deploy/spend against sibling app B in the
 * same org. `isCrossAppKeyUsage` (the real predicate the /apps/[id]/* routes gate
 * on) restricts an app key to its own app while leaving org keys / sessions with
 * full org access.
 */
import { describe, expect, test } from "bun:test";
import { isCrossAppKeyUsage } from "@/lib/auth/app-key-scope";

describe("isCrossAppKeyUsage (#10852)", () => {
  test("app A's key acting on sibling app B → DENY", () => {
    expect(
      isCrossAppKeyUsage({
        apiKeyId: "key-A",
        owningAppId: "app-A",
        requestedAppId: "app-B",
      }),
    ).toBe(true);
  });

  test("app A's key acting on its own app A → allow", () => {
    expect(
      isCrossAppKeyUsage({
        apiKeyId: "key-A",
        owningAppId: "app-A",
        requestedAppId: "app-A",
      }),
    ).toBe(false);
  });

  test("normal org key (no app claims it) → allow (full org access unchanged)", () => {
    expect(
      isCrossAppKeyUsage({
        apiKeyId: "org-key",
        owningAppId: undefined,
        requestedAppId: "app-B",
      }),
    ).toBe(false);
  });

  test("session auth (no api key) → allow", () => {
    expect(
      isCrossAppKeyUsage({
        apiKeyId: undefined,
        owningAppId: undefined,
        requestedAppId: "app-B",
      }),
    ).toBe(false);
  });

  test("session auth but an app happens to match id → still allow (no key presented)", () => {
    // Defensive: without an api key there is no app-key credential to constrain.
    expect(
      isCrossAppKeyUsage({
        apiKeyId: null,
        owningAppId: "app-A",
        requestedAppId: "app-B",
      }),
    ).toBe(false);
  });
});

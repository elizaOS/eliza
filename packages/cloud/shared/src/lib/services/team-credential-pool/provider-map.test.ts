/**
 * Pins the team credential pool's provider surface (#11332). Two invariants
 * matter beyond the type system: the pooled and subscription provider sets must
 * stay disjoint, because Phase 1 must refuse per-seat licenses outright; and
 * the env-var map must stay identical to the canonical
 * DIRECT_ACCOUNT_PROVIDER_ENV it mirrors, because a pooled key is delivered to
 * the agent under that name. That canonical map is pinned literally below
 * rather than imported: `@elizaos/auth/types` transitively reaches
 * `@elizaos/cloud-routing`, which is not built in this package's test lane.
 * Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import {
  isPooledDirectProvider,
  isSubscriptionProviderId,
  keyLast4,
  POOLED_DIRECT_PROVIDERS,
  POOLED_PROVIDER_ENV_KEYS,
  POOLED_PROVIDER_SECRET_PROVIDER,
  SUBSCRIPTION_PROVIDER_IDS,
} from "./provider-map";

describe("provider sets", () => {
  test("pooled and subscription provider ids are disjoint", () => {
    const subscription = new Set<string>(SUBSCRIPTION_PROVIDER_IDS);
    const overlap = POOLED_DIRECT_PROVIDERS.filter((id) => subscription.has(id));
    expect(overlap).toEqual([]);
  });

  test("no subscription provider is accepted as poolable", () => {
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      expect(isPooledDirectProvider(id)).toBe(false);
    }
  });

  test("no pooled provider is classified as a subscription", () => {
    for (const id of POOLED_DIRECT_PROVIDERS) {
      expect(isSubscriptionProviderId(id)).toBe(false);
    }
  });

  test("neither list contains duplicates", () => {
    expect(new Set(POOLED_DIRECT_PROVIDERS).size).toBe(POOLED_DIRECT_PROVIDERS.length);
    expect(new Set(SUBSCRIPTION_PROVIDER_IDS).size).toBe(SUBSCRIPTION_PROVIDER_IDS.length);
  });

  test("every id is a non-empty lowercase slug", () => {
    for (const id of [...POOLED_DIRECT_PROVIDERS, ...SUBSCRIPTION_PROVIDER_IDS]) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("isPooledDirectProvider", () => {
  test("accepts exactly the declared pooled providers", () => {
    for (const id of POOLED_DIRECT_PROVIDERS) {
      expect(isPooledDirectProvider(id)).toBe(true);
    }
  });

  test("rejects unknown, empty, and near-miss values", () => {
    for (const value of [
      "",
      "anthropic",
      "anthropic-api ",
      " anthropic-api",
      "ANTHROPIC-API",
      "openai",
      "not-a-provider",
    ]) {
      expect(isPooledDirectProvider(value)).toBe(false);
    }
  });

  test("rejects inherited Object.prototype keys", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(isPooledDirectProvider(key)).toBe(false);
      expect(isSubscriptionProviderId(key)).toBe(false);
    }
  });
});

describe("provider lookup tables", () => {
  test("every pooled provider has an env key", () => {
    for (const id of POOLED_DIRECT_PROVIDERS) {
      expect(Object.hasOwn(POOLED_PROVIDER_ENV_KEYS, id)).toBe(true);
      expect(POOLED_PROVIDER_ENV_KEYS[id]).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("every pooled provider has a secrets-vault provider", () => {
    for (const id of POOLED_DIRECT_PROVIDERS) {
      expect(Object.hasOwn(POOLED_PROVIDER_SECRET_PROVIDER, id)).toBe(true);
      expect(typeof POOLED_PROVIDER_SECRET_PROVIDER[id]).toBe("string");
      expect(POOLED_PROVIDER_SECRET_PROVIDER[id].length).toBeGreaterThan(0);
    }
  });

  test("the lookup tables carry no keys beyond the pooled set", () => {
    const pooled = [...POOLED_DIRECT_PROVIDERS].sort();
    expect(Object.keys(POOLED_PROVIDER_ENV_KEYS).sort()).toEqual(pooled);
    expect(Object.keys(POOLED_PROVIDER_SECRET_PROVIDER).sort()).toEqual(pooled);
  });

  test("distinct providers never share one env var", () => {
    const envKeys = Object.values(POOLED_PROVIDER_ENV_KEYS);
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });

  // Mirror of DIRECT_ACCOUNT_PROVIDER_ENV in packages/auth/src/types.ts, which
  // this module's own doc comment names as the source of truth. Pinned by value
  // so a rename on either side fails here instead of silently handing the agent
  // a key under a name it does not read.
  test("env map matches the canonical DIRECT_ACCOUNT_PROVIDER_ENV", () => {
    expect(POOLED_PROVIDER_ENV_KEYS).toEqual({
      "anthropic-api": "ANTHROPIC_API_KEY",
      "openai-api": "OPENAI_API_KEY",
      "deepseek-api": "DEEPSEEK_API_KEY",
      "zai-api": "ZAI_API_KEY",
      "moonshot-api": "MOONSHOT_API_KEY",
      "cerebras-api": "CEREBRAS_API_KEY",
    });
  });
});

describe("keyLast4", () => {
  test("returns the final four characters of a realistic key", () => {
    expect(keyLast4("sk-ant-api03-abcdefghijklmnop9Z7q")).toBe("9Z7q");
    expect(keyLast4("0123456789")).toBe("6789");
  });

  test("is exactly four characters for any key of at least four", () => {
    for (const key of ["abcd", "abcde", "x".repeat(200)]) {
      expect(keyLast4(key).length).toBe(4);
    }
  });

  test("preserves the tail verbatim, including non-alphanumerics", () => {
    expect(keyLast4("secret-_+=")).toBe("-_+=");
  });
});

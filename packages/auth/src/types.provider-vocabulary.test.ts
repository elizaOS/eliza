/**
 * Pins the account credential provider vocabulary in types.ts: the runtime
 * guards that validate client-supplied provider IDs at the accounts API and
 * credential-storage boundaries, the auth-mode partition every subscription
 * provider must satisfy exactly once, and the wiring with production
 * consumers (direct-provider env vars read by credential-resolver and the
 * account pool, model-provider names read by credentials.ts, coding-plan
 * endpoints read by accounts-routes.ts).
 *
 * Fields without a production consumer are deliberately not byte-pinned
 * here. Beyond `selectionIds` and `directProviderId`, the metadata fields
 * `providerId`, `authMode`, `defaultBaseUrl`, and `probePath` also have no
 * reader outside their declaration (the provider-choice and fallback paths
 * source their data from the first-run provider catalog in @elizaos/core,
 * and route handlers read `CODING_PLAN_PROVIDER_BASE_URL` directly, not the
 * metadata copy). Pinning them would be lockstep mirroring of dead metadata.
 * The wiring that IS consumed is pinned: `DIRECT_ACCOUNT_PROVIDER_ENV`
 * (credential-resolver + account-pool), `SUBSCRIPTION_PROVIDER_MAP`
 * (credentials.ts), `CODING_PLAN_PROVIDER_BASE_URL` (accounts-routes.ts),
 * and metadata `availability`/`allowedClient`/`setupHint`/`billingMode`/
 * `availabilityReason` (credentials.ts subscriptionStatusMetadata, rendered
 * by the UI subscription status view). `selectionIds` and
 * `directProviderId` are only checked for agreement with the real first-run
 * catalog wiring so the two cannot drift apart.
 *
 * Real module, deterministic, no mocks: every case calls the exported
 * functions with concrete inputs. The discriminating cases are near-miss
 * strings and cross-vocabulary confusions (an OAuth id is not a coding-plan
 * id; a direct API provider is not a subscription), so a guard that starts
 * checking the wrong list, or a provider added to one list but not its
 * partition, fails here. The consumers of the guards themselves are
 * exercised at their own boundaries: connect-account.test.ts (agent)
 * covers the availability filter that offers providers in-chat.
 */
import {
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderOption,
  getStoredSubscriptionProviderForRequest,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS,
  CODING_PLAN_PROVIDER_BASE_URL,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
  EXTERNAL_CLI_SUBSCRIPTION_PROVIDER_IDS,
  getSubscriptionProviderMetadata,
  isAccountCredentialProvider,
  isCodingPlanKeySubscriptionProvider,
  isDirectAccountProvider,
  isExternalCliSubscriptionProvider,
  isOAuthSubscriptionProvider,
  isSubscriptionProvider,
  isUnavailableSubscriptionProvider,
  OAUTH_SUBSCRIPTION_PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_MAP,
  UNAVAILABLE_SUBSCRIPTION_PROVIDER_IDS,
} from "./types.ts";

/** Inputs no provider guard may accept, regardless of vocabulary. */
const NON_STRINGS: unknown[] = [null, undefined, 42, 0, true, {}, [], [""]];

/** Strings close enough to real IDs that a sloppy membership check would pass. */
const NEAR_MISS_IDS = [
  "",
  " ",
  "anthropic-subscription2",
  "Anthropic-Subscription",
  "ANTHROPIC-SUBSCRIPTION",
  "anthropic-subscriptions",
  " anthropic-subscription",
  "anthropic-subscription ",
  "openai_codex",
  "zai-coding\n",
];

const allGuards = [
  isSubscriptionProvider,
  isDirectAccountProvider,
  isOAuthSubscriptionProvider,
  isCodingPlanKeySubscriptionProvider,
  isExternalCliSubscriptionProvider,
  isUnavailableSubscriptionProvider,
  isAccountCredentialProvider,
] as const;

describe("provider guards reject non-string input", () => {
  for (const guard of allGuards) {
    it(`${guard.name} rejects every non-string value`, () => {
      for (const value of NON_STRINGS) {
        expect(guard(value), `${guard.name}(${JSON.stringify(value)})`).toBe(
          false,
        );
      }
    });
  }
});

describe("provider guards reject near-miss IDs", () => {
  for (const guard of allGuards) {
    it(`${guard.name} rejects every near-miss string`, () => {
      for (const value of NEAR_MISS_IDS) {
        expect(guard(value), JSON.stringify(value)).toBe(false);
      }
    });
  }
});

describe("guards discriminate between provider vocabularies", () => {
  it("OAuth accepts only the two OAuth-capable subscription providers", () => {
    expect([...OAUTH_SUBSCRIPTION_PROVIDER_IDS]).toEqual([
      "anthropic-subscription",
      "openai-codex",
    ]);
    expect(isOAuthSubscriptionProvider("anthropic-subscription")).toBe(true);
    expect(isOAuthSubscriptionProvider("openai-codex")).toBe(true);
    // Subscription providers that authenticate by other means.
    expect(isOAuthSubscriptionProvider("gemini-cli")).toBe(false);
    expect(isOAuthSubscriptionProvider("zai-coding")).toBe(false);
    expect(isOAuthSubscriptionProvider("kimi-coding")).toBe(false);
    expect(isOAuthSubscriptionProvider("deepseek-coding")).toBe(false);
  });

  it("coding-plan-key accepts exactly the plan-key providers", () => {
    expect([...CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS]).toEqual([
      "zai-coding",
      "kimi-coding",
    ]);
    expect(isCodingPlanKeySubscriptionProvider("zai-coding")).toBe(true);
    expect(isCodingPlanKeySubscriptionProvider("kimi-coding")).toBe(true);
    expect(isCodingPlanKeySubscriptionProvider("anthropic-subscription")).toBe(
      false,
    );
    expect(isCodingPlanKeySubscriptionProvider("gemini-cli")).toBe(false);
  });

  it("external-cli accepts exactly gemini-cli", () => {
    expect([...EXTERNAL_CLI_SUBSCRIPTION_PROVIDER_IDS]).toEqual(["gemini-cli"]);
    expect(isExternalCliSubscriptionProvider("gemini-cli")).toBe(true);
    expect(isExternalCliSubscriptionProvider("openai-codex")).toBe(false);
    expect(isExternalCliSubscriptionProvider("deepseek-coding")).toBe(false);
  });

  it("unavailable accepts exactly deepseek-coding", () => {
    expect([...UNAVAILABLE_SUBSCRIPTION_PROVIDER_IDS]).toEqual([
      "deepseek-coding",
    ]);
    expect(isUnavailableSubscriptionProvider("deepseek-coding")).toBe(true);
    expect(isUnavailableSubscriptionProvider("zai-coding")).toBe(false);
    expect(isUnavailableSubscriptionProvider("anthropic-subscription")).toBe(
      false,
    );
  });

  it("subscription and direct-account vocabularies do not overlap", () => {
    expect(isSubscriptionProvider("anthropic-api")).toBe(false);
    expect(isSubscriptionProvider("zai-api")).toBe(false);
    expect(isDirectAccountProvider("anthropic-subscription")).toBe(false);
    expect(isDirectAccountProvider("openai-codex")).toBe(false);
    expect(isDirectAccountProvider("anthropic-api")).toBe(true);
    expect(isDirectAccountProvider("cerebras-api")).toBe(true);
  });

  it("account-credential accepts both subscription and direct providers", () => {
    expect(isAccountCredentialProvider("anthropic-subscription")).toBe(true);
    expect(isAccountCredentialProvider("deepseek-coding")).toBe(true);
    expect(isAccountCredentialProvider("moonshot-api")).toBe(true);
    // Near-miss of a real account credential provider.
    expect(isAccountCredentialProvider("moonshot-api ")).toBe(false);
    expect(isAccountCredentialProvider("openai-codex-api")).toBe(false);
  });
});

describe("vocabulary invariants", () => {
  it("every OAuth, coding-plan, external-cli, and unavailable ID is a subscription provider", () => {
    const narrower = [
      ...OAUTH_SUBSCRIPTION_PROVIDER_IDS,
      ...CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS,
      ...EXTERNAL_CLI_SUBSCRIPTION_PROVIDER_IDS,
      ...UNAVAILABLE_SUBSCRIPTION_PROVIDER_IDS,
    ];
    expect(narrower.length).toBeGreaterThan(0);
    for (const id of narrower) {
      expect(isSubscriptionProvider(id), id).toBe(true);
    }
  });

  it("every subscription provider satisfies exactly one auth-mode partition", () => {
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const modes = [
        isOAuthSubscriptionProvider(id),
        isCodingPlanKeySubscriptionProvider(id),
        isExternalCliSubscriptionProvider(id),
        isUnavailableSubscriptionProvider(id),
      ];
      const active = modes.filter(Boolean).length;
      expect(
        active,
        `${id} participates in ${active} auth modes (expected exactly 1)`,
      ).toBe(1);
    }
  });

  it("account-credential vocabulary is subscription plus direct providers", () => {
    const expected = new Set<string>([
      ...SUBSCRIPTION_PROVIDER_IDS,
      ...DIRECT_ACCOUNT_PROVIDER_IDS,
    ]);
    expect(new Set(ACCOUNT_CREDENTIAL_PROVIDER_IDS)).toEqual(expected);
    for (const id of expected) {
      expect(isAccountCredentialProvider(id), id).toBe(true);
    }
  });
});

describe("getSubscriptionProviderMetadata", () => {
  it("returns entries whose consumed fields are populated for every provider", () => {
    // displayName (connect-account.ts), allowedClient/setupHint/billingMode/
    // availability/availabilityReason (credentials.ts
    // subscriptionStatusMetadata, rendered by the UI subscription status
    // view) are the metadata fields with production readers.
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const metadata = getSubscriptionProviderMetadata(id);
      expect(metadata, id).toBeDefined();
      expect(metadata.displayName.length).toBeGreaterThan(0);
      expect(metadata.allowedClient.length).toBeGreaterThan(0);
      expect(metadata.setupHint.length).toBeGreaterThan(0);
      expect(["subscription-coding-plan", "subscription-coding-cli"]).toContain(
        metadata.billingMode,
      );
      expect(["available", "external", "unavailable"]).toContain(
        metadata.availability,
      );
      // subscriptionStatusMetadata forwards availabilityReason to the UI only
      // for unavailable providers; an unavailable provider without a reason
      // renders an unexplained dead row.
      if (metadata.availability === "unavailable") {
        expect(
          metadata.availabilityReason,
          `${id} is unavailable but has no availabilityReason`,
        ).toBeTruthy();
      }
    }
  });

  it("metadata selectionIds resolve back to this provider through the first-run catalog", () => {
    // The UI/account flow matches persisted selection IDs (e.g.
    // "openai-subscription") back to stored providers via core's
    // SUBSCRIPTION_PROVIDER_SELECTIONS; auth's metadata selectionIds must
    // agree with that mapping or a selection silently re-routes accounts.
    // This exercises the real consumer function rather than mirroring the
    // literal arrays.
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      for (const selectionId of getSubscriptionProviderMetadata(id)
        .selectionIds) {
        expect(
          getStoredSubscriptionProviderForRequest(selectionId),
          `${selectionId} should store as ${id}`,
        ).toBe(id);
      }
    }
    // The stored provider id itself round-trips too.
    expect(
      getStoredSubscriptionProviderForRequest("anthropic-subscription"),
    ).toBe("anthropic-subscription");
    expect(getStoredSubscriptionProviderForRequest("openai-codex")).toBe(
      "openai-codex",
    );
    // Near-miss and non-selection inputs resolve to null, never a provider.
    expect(
      getStoredSubscriptionProviderForRequest("openai-subscription2"),
    ).toBe(null);
    expect(getStoredSubscriptionProviderForRequest(42 as unknown)).toBe(null);
  });

  it("metadata directProviderId, when present, agrees with the first-run fallback wiring", () => {
    // Production fallback resolution goes through core's
    // getDirectAccountProviderForFirstRunProvider (credential-resolver,
    // ProviderSwitcher). The auth metadata's directProviderId is not read by
    // that path, but the two must not disagree, or the metadata will
    // misdescribe the fallback users actually get. The provider-to-family
    // association is derived from the first-run catalog itself, not from
    // another literal map.
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const option = getFirstRunProviderOption(id);
      if (!option) {
        throw new Error(`Missing first-run provider option for ${id}`);
      }
      const { directProviderId } = getSubscriptionProviderMetadata(id);
      expect(
        getDirectAccountProviderForFirstRunProvider(option.family),
        `${id} (family ${option.family}) first-run fallback`,
      ).toBe(directProviderId ?? null);
    }
  });
});

describe("direct-provider maps are complete and correctly wired", () => {
  it("every direct provider has a distinct non-empty env var", () => {
    const seen = new Set<string>();
    for (const id of DIRECT_ACCOUNT_PROVIDER_IDS) {
      const envVar = DIRECT_ACCOUNT_PROVIDER_ENV[id];
      expect(envVar, `DIRECT_ACCOUNT_PROVIDER_ENV[${id}]`).toBeDefined();
      expect(envVar.length).toBeGreaterThan(0);
      // Two providers silently sharing one env var would cross-wire keys.
      expect(seen.has(envVar), `duplicate env var ${envVar}`).toBe(false);
      seen.add(envVar);
    }
  });

  it("pins the provider-to-env-var wiring credential resolution reads", () => {
    // A swapped entry cross-wires API keys between providers at runtime.
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["anthropic-api"]).toBe(
      "ANTHROPIC_API_KEY",
    );
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["openai-api"]).toBe("OPENAI_API_KEY");
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["deepseek-api"]).toBe(
      "DEEPSEEK_API_KEY",
    );
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["zai-api"]).toBe("ZAI_API_KEY");
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["moonshot-api"]).toBe(
      "MOONSHOT_API_KEY",
    );
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["cerebras-api"]).toBe(
      "CEREBRAS_API_KEY",
    );
  });

  it("every subscription provider maps to a distinct model provider name", () => {
    const seen = new Set<string>();
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const shortName = SUBSCRIPTION_PROVIDER_MAP[id];
      expect(shortName, `SUBSCRIPTION_PROVIDER_MAP[${id}]`).toBeDefined();
      expect(shortName.length).toBeGreaterThan(0);
      expect(seen.has(shortName), `duplicate model provider ${shortName}`).toBe(
        false,
      );
      seen.add(shortName);
    }
  });

  it("pins the subscription-to-model-provider wiring", () => {
    // Substituting one provider's short name for another's silently routes
    // subscription inference to the wrong backend.
    expect(SUBSCRIPTION_PROVIDER_MAP["anthropic-subscription"]).toBe(
      "anthropic",
    );
    expect(SUBSCRIPTION_PROVIDER_MAP["openai-codex"]).toBe("codex-cli");
    expect(SUBSCRIPTION_PROVIDER_MAP["gemini-cli"]).toBe("gemini-cli");
    expect(SUBSCRIPTION_PROVIDER_MAP["zai-coding"]).toBe("zai-coding");
    expect(SUBSCRIPTION_PROVIDER_MAP["kimi-coding"]).toBe("kimi-coding");
    expect(SUBSCRIPTION_PROVIDER_MAP["deepseek-coding"]).toBe(
      "deepseek-coding",
    );
  });

  it("coding-plan base URLs pin their dedicated endpoints", () => {
    expect(CODING_PLAN_PROVIDER_BASE_URL["zai-coding"]).toBe(
      "https://api.z.ai/api/coding/paas/v4",
    );
    expect(CODING_PLAN_PROVIDER_BASE_URL["kimi-coding"]).toBe(
      "https://api.kimi.com/coding/v1",
    );
    expect(Object.keys(CODING_PLAN_PROVIDER_BASE_URL).sort()).toEqual(
      [...CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS].sort(),
    );
  });
});

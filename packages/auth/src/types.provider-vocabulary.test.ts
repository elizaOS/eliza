/**
 * Pins the account credential provider vocabulary in types.ts: the runtime
 * guards that validate client-supplied provider IDs at the accounts API and
 * credential-storage boundaries, the auth-mode partition every subscription
 * provider must satisfy exactly once, the metadata associations relied on by
 * connect-account.ts and credentials.ts (selection IDs, direct-provider
 * fallbacks, coding-plan endpoints), and the provider-to-env-var and
 * provider-to-model-name wiring consumed when materializing credentials.
 *
 * Real module, deterministic, no mocks: every case calls the exported
 * functions with concrete inputs. The discriminating cases are near-miss
 * strings and cross-vocabulary confusions (an OAuth id is not a coding-plan
 * id; a direct API provider is not a subscription), so a guard that starts
 * checking the wrong list, or a provider added to one list but not its
 * partition, fails here.
 */
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
    expect(isOAuthSubscriptionProvider("anthropic-subscription")).toBe(true);
    expect(isOAuthSubscriptionProvider("openai-codex")).toBe(true);
    // Subscription providers that authenticate by other means.
    expect(isOAuthSubscriptionProvider("gemini-cli")).toBe(false);
    expect(isOAuthSubscriptionProvider("zai-coding")).toBe(false);
    expect(isOAuthSubscriptionProvider("kimi-coding")).toBe(false);
    expect(isOAuthSubscriptionProvider("deepseek-coding")).toBe(false);
  });

  it("coding-plan-key accepts exactly the plan-key providers", () => {
    expect(isCodingPlanKeySubscriptionProvider("zai-coding")).toBe(true);
    expect(isCodingPlanKeySubscriptionProvider("kimi-coding")).toBe(true);
    expect(isCodingPlanKeySubscriptionProvider("anthropic-subscription")).toBe(
      false,
    );
    expect(isCodingPlanKeySubscriptionProvider("gemini-cli")).toBe(false);
  });

  it("external-cli accepts exactly gemini-cli", () => {
    expect(isExternalCliSubscriptionProvider("gemini-cli")).toBe(true);
    expect(isExternalCliSubscriptionProvider("openai-codex")).toBe(false);
    expect(isExternalCliSubscriptionProvider("deepseek-coding")).toBe(false);
  });

  it("unavailable accepts exactly deepseek-coding", () => {
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
  it("returns a structurally complete entry for every subscription provider", () => {
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const metadata = getSubscriptionProviderMetadata(id);
      expect(metadata, id).toBeDefined();
      // A wrong-keyed record would echo a different providerId back.
      expect(metadata.providerId).toBe(id);
      expect(metadata.displayName.length).toBeGreaterThan(0);
      expect(metadata.allowedClient.length).toBeGreaterThan(0);
      expect(metadata.setupHint.length).toBeGreaterThan(0);
      expect(["subscription-coding-plan", "subscription-coding-cli"]).toContain(
        metadata.billingMode,
      );
      expect(["available", "external", "unavailable"]).toContain(
        metadata.availability,
      );
    }
  });

  it("pins the selectionIds consumers use to choose a provider", () => {
    // The UI/account flow matches persisted selection IDs back to providers;
    // swapping them between providers silently re-routes accounts.
    const expectedSelectionIds: Record<string, readonly string[]> = {
      "anthropic-subscription": ["anthropic-subscription"],
      "openai-codex": ["openai-subscription"],
      "gemini-cli": ["gemini-subscription"],
      "zai-coding": ["zai-coding-subscription"],
      "kimi-coding": ["kimi-coding-subscription"],
      "deepseek-coding": ["deepseek-coding-subscription"],
    };
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      expect(getSubscriptionProviderMetadata(id).selectionIds).toEqual(
        expectedSelectionIds[id],
      );
    }
  });

  it("pins which subscription providers carry a direct-provider fallback", () => {
    const expectedDirect: Record<string, string | undefined> = {
      "anthropic-subscription": "anthropic-api",
      "openai-codex": "openai-api",
      "gemini-cli": undefined,
      "zai-coding": "zai-api",
      "kimi-coding": "moonshot-api",
      "deepseek-coding": "deepseek-api",
    };
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      expect(getSubscriptionProviderMetadata(id).directProviderId).toBe(
        expectedDirect[id],
      );
    }
  });

  it("coding-plan providers point at their dedicated endpoint", () => {
    for (const id of CODING_PLAN_KEY_SUBSCRIPTION_PROVIDER_IDS) {
      const metadata = getSubscriptionProviderMetadata(id);
      expect(metadata.defaultBaseUrl).toBe(CODING_PLAN_PROVIDER_BASE_URL[id]);
      expect(metadata.probePath).toBe("/models");
    }
    // Non-plan providers do not carry a plan endpoint.
    expect(
      getSubscriptionProviderMetadata("anthropic-subscription").defaultBaseUrl,
    ).toBeUndefined();
  });

  it("metadata authMode agrees with the guard partition", () => {
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const { authMode } = getSubscriptionProviderMetadata(id);
      expect(
        isOAuthSubscriptionProvider(id),
        `${id} authMode=${authMode} vs isOAuthSubscriptionProvider`,
      ).toBe(authMode === "oauth");
      expect(
        isCodingPlanKeySubscriptionProvider(id),
        `${id} authMode=${authMode} vs isCodingPlanKeySubscriptionProvider`,
      ).toBe(authMode === "coding-plan-key");
      expect(
        isExternalCliSubscriptionProvider(id),
        `${id} authMode=${authMode} vs isExternalCliSubscriptionProvider`,
      ).toBe(authMode === "external-cli");
      expect(
        isUnavailableSubscriptionProvider(id),
        `${id} authMode=${authMode} vs isUnavailableSubscriptionProvider`,
      ).toBe(authMode === "unavailable");
    }
  });

  it("directProviderId, when present, names a real direct-account provider", () => {
    for (const id of SUBSCRIPTION_PROVIDER_IDS) {
      const { directProviderId } = getSubscriptionProviderMetadata(id);
      if (directProviderId === undefined) continue;
      expect(isDirectAccountProvider(directProviderId), id).toBe(true);
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

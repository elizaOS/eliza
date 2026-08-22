/**
 * Deterministically verifies the non-secret coding-policy receipt stamped on
 * each ACP session. The helper is exercised without spawning a subprocess.
 */
import { describe, expect, it } from "vitest";
import { buildCodingPolicyMetadata } from "../services/acp-service.js";

describe("buildCodingPolicyMetadata", () => {
  it("records backend/provider/account/model/billing policy without credentials", () => {
    const settings: Record<string, string> = {
      ELIZA_CODING_BILLING_MODE: "subscription-plus-overage",
      ELIZA_CODING_FALLBACK_BACKENDS: "claude,opencode",
      OPENAI_API_KEY: "must-not-appear",
    };
    const metadata = buildCodingPolicyMetadata({
      backend: "codex",
      model: "gpt-5.6-sol",
      account: {
        providerId: "openai-codex",
        accountId: "acct-primary",
        label: "Primary",
        source: "oauth",
        strategy: "quota-aware",
      },
      approvalPreset: "standard",
      accountStrategy: "quota-aware",
      readSetting: (key) => settings[key],
    });

    expect(metadata).toEqual({
      backend: "codex",
      provider: "openai-codex",
      accountId: "acct-primary",
      accountSource: "oauth",
      model: "gpt-5.6-sol",
      expectedBillingMode: "subscription-plus-overage",
      observedCredentialSource: "oauth",
      actualBillingMode: null,
      billingVerification: "declared-only",
      fallbackBackends: ["claude", "opencode"],
      approvalPreset: "standard",
      accountStrategy: "quota-aware",
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-appear");
    expect(JSON.stringify(metadata)).not.toContain("API_KEY");
  });

  it("normalizes an unrecognized billing value to automatic", () => {
    expect(
      buildCodingPolicyMetadata({
        backend: "opencode",
        account: null,
        approvalPreset: "readonly",
        readSetting: () => "invented-billing-mode",
      }).expectedBillingMode,
    ).toBe("automatic");
  });
});

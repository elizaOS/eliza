/**
 * Unit tests for cloud-dashboard-utils: validates OAuth callback parsers, billing transformers, and auto top-up form reducer.
 */
import { describe, expect, it } from "vitest";
import {
  autoTopUpFormReducer,
  buildAutoTopUpFormState,
  consumeManagedDiscordCallbackUrl,
  consumeManagedGithubCallbackUrl,
  normalizeBillingSettings,
  normalizeBillingSummary,
  readNumber,
  resolveCheckoutUrl,
} from "./cloud-dashboard-utils.ts";

describe("cloud-dashboard-utils", () => {
  it("reads and parses numbers from mixed string and number values", () => {
    expect(readNumber(42)).toBe(42);
    expect(readNumber("100.5")).toBe(100.5);
    expect(readNumber("invalid")).toBeNull();
    expect(readNumber(null)).toBeNull();
    expect(readNumber(Number.NaN)).toBeNull();
  });

  it("parses managed Discord OAuth callback URLs", () => {
    const successUrl =
      "https://app.eliza.app/settings?discord=connected&managed=1&agentId=agent-1&guildId=g-1&guildName=GuildName";
    const { callback, cleanedUrl } =
      consumeManagedDiscordCallbackUrl(successUrl);
    expect(callback?.status).toBe("connected");
    expect(callback?.agentId).toBe("agent-1");
    expect(callback?.guildId).toBe("g-1");
    expect(callback?.guildName).toBe("GuildName");
    expect(cleanedUrl).not.toContain("discord=");

    const errorUrl =
      "https://app.eliza.app/settings?discord=error&managed=1&message=access_denied";
    const errorState = consumeManagedDiscordCallbackUrl(errorUrl);
    expect(errorState.callback?.status).toBe("error");
    expect(errorState.callback?.message).toBe("access_denied");
  });

  it("parses managed GitHub OAuth callback URLs", () => {
    const ghUrl =
      "https://app.eliza.app/settings?github_connected=true&connection_id=conn-123&managed_github_agent=agent-1";
    const { callback, cleanedUrl } = consumeManagedGithubCallbackUrl(ghUrl);
    expect(callback?.status).toBe("connected");
    expect(callback?.connectionId).toBe("conn-123");
    expect(callback?.agentId).toBe("agent-1");
    expect(cleanedUrl).not.toContain("github_connected=");
  });

  it("normalizes billing summary and settings into typed DTOs", () => {
    const rawSummary = {
      balance: "50.00",
      spendUsd: 12.5,
      currency: "usd",
    };
    const normalized = normalizeBillingSummary(
      rawSummary as unknown as Parameters<typeof normalizeBillingSummary>[0],
    );
    expect(normalized.balance).toBe(50);
    expect(normalized.spendUsd).toBe(12.5);

    const rawSettings = {
      settings: { autoTopUp: { enabled: true, threshold: 10, amount: 25 } },
    };
    const settings = normalizeBillingSettings(
      rawSettings as unknown as Parameters<typeof normalizeBillingSettings>[0],
    );
    expect(settings.settings).toBeDefined();
  });

  it("resolves checkout URLs and validates auto top-up form state reducer transitions", () => {
    expect(resolveCheckoutUrl({ checkoutUrl: "https://stripe.com/pay" })).toBe(
      "https://stripe.com/pay",
    );
    expect(
      resolveCheckoutUrl({ url: "https://checkout.stripe.com/c/pay" }),
    ).toBe("https://checkout.stripe.com/c/pay");
    expect(resolveCheckoutUrl({})).toBeNull();

    const initialForm = buildAutoTopUpFormState(null, {
      settings: { autoTopUp: { enabled: false, threshold: 5, amount: 20 } },
    } as unknown as Parameters<typeof buildAutoTopUpFormState>[1]);
    expect(initialForm.enabled).toBe(false);

    const updatedEnabled = autoTopUpFormReducer(initialForm, {
      type: "setEnabled",
      value: true,
    });
    expect(updatedEnabled.enabled).toBe(true);
    expect(updatedEnabled.dirty).toBe(true);

    const updatedAmount = autoTopUpFormReducer(updatedEnabled, {
      type: "setAmount",
      value: "50",
    });
    expect(updatedAmount.amount).toBe("50");
  });
});

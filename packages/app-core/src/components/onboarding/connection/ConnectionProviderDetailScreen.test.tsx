// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useAppMock = vi.fn();
const openExternalUrlMock = vi.fn();
const startAnthropicLoginMock = vi.fn();
const exchangeAnthropicCodeMock = vi.fn();
const submitAnthropicSetupTokenMock = vi.fn();

vi.mock("../../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../../config", () => ({
  useBranding: () => ({
    bugReportUrl: "https://example.com/bug-report",
    customProviders: [],
  }),
}));

vi.mock("../../../providers", () => ({
  getProviderLogo: () => "/provider-logo.png",
  requiresAdditionalRuntimeProvider: (providerId: string) =>
    providerId === "anthropic-subscription",
}));

vi.mock("../../../bridge/electrobun-rpc", () => ({
  getElectrobunRendererRpc: () => null,
}));

vi.mock("../../../utils", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

vi.mock("../../../api", () => ({
  client: {
    startAnthropicLogin: (...args: unknown[]) =>
      startAnthropicLoginMock(...args),
    exchangeAnthropicCode: (...args: unknown[]) =>
      exchangeAnthropicCodeMock(...args),
    submitAnthropicSetupToken: (...args: unknown[]) =>
      submitAnthropicSetupTokenMock(...args),
  },
}));

import { ConnectionProviderDetailScreen } from "./ConnectionProviderDetailScreen";

const providers = [
  {
    id: "anthropic-subscription",
    name: "Claude Sub",
    envKey: null,
    pluginName: "@elizaos/plugin-anthropic",
    keyPrefix: "sk-ant-",
    description: "Task agents only (Claude Code CLI)",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    pluginName: "@elizaos/plugin-anthropic",
    keyPrefix: "sk-ant-",
    description: "Claude API key",
  },
];

const translations: Record<string, string> = {
  "onboarding.apiKey": "API key",
  "onboarding.authCodeInstructions":
    "Paste the authorization code from Claude after login.",
  "onboarding.back": "Back",
  "onboarding.chooseProvider": "Choose your AI provider",
  "onboarding.connect": "Connect",
  "onboarding.connected": "Connected",
  "onboarding.connectedToClaude": "Connected to Claude",
  "onboarding.enterApiKey": "Enter API key",
  "onboarding.configureAiLater": "Set up later",
  "onboarding.loginWithAnthropic": "Login with Claude",
  "onboarding.oauthLogin": "OAuth Login",
  "onboarding.paste": "Paste",
  "onboarding.pasteAuthCode": "Paste authorization code...",
  "onboarding.providerAnthropicApiKeyDescription": "Claude API key",
  "onboarding.providerClaudeSubscription": "Claude Sub",
  "onboarding.providerClaudeSubscriptionDetailDescription":
    "Task agents only (Claude Code CLI)",
  "onboarding.requiresClaudeSub": "Requires a Claude Pro or Max subscription.",
  "onboarding.saveClaudeSubscription": "Save Claude subscription",
  "onboarding.savingClaudeSubscription": "Saving Claude subscription...",
  "onboarding.setupToken": "Setup token",
  "onboarding.setupTokenInstructions":
    'How to get your setup token:\n\n• Option A: Run  claude setup-token  in your terminal\n\n• Option B: Go to claude.ai/settings/api → "Claude Code" → "Use setup token"',
  "subscriptionstatus.ClaudeTosWarning":
    "Claude subscriptions can only be used through the Claude Code CLI (Anthropic TOS). Your subscription will power task agents but not the main agent runtime. For the main agent, use Eliza Cloud, a direct Anthropic API key, or another provider.",
  "subscriptionstatus.ClaudeTosWarningShort":
    "Powers task agents only (Claude Code CLI). For the main agent runtime, connect Eliza Cloud or a direct API key.",
};

function t(key: string, options?: { defaultValue?: string }): string {
  return translations[key] ?? options?.defaultValue ?? key;
}

function buildAppState(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    onboardingOptions: { providers },
    onboardingProvider: "anthropic-subscription",
    onboardingSubscriptionTab: "token",
    onboardingCloudApiKey: "",
    onboardingApiKey: "",
    onboardingPrimaryModel: "",
    onboardingElizaCloudTab: "login",
    onboardingOpenRouterModel: "",
    elizaCloudConnected: false,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    handleCloudLogin: vi.fn(),
    handleOnboardingNext: vi.fn(),
    setState: vi.fn(),
    t,
    ...overrides,
  };
}

describe("ConnectionProviderDetailScreen", () => {
  beforeEach(() => {
    startAnthropicLoginMock.mockResolvedValue({
      authUrl: "https://claude.ai/oauth/authorize?state=test",
    });
    exchangeAnthropicCodeMock.mockResolvedValue({ success: true });
    submitAnthropicSetupTokenMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
    useAppMock.mockReset();
    openExternalUrlMock.mockReset();
    startAnthropicLoginMock.mockReset();
    exchangeAnthropicCodeMock.mockReset();
    submitAnthropicSetupTokenMock.mockReset();
  });

  it("shows the setup-token flow for Claude subscriptions", () => {
    useAppMock.mockReturnValue(buildAppState());

    render(<ConnectionProviderDetailScreen dispatch={vi.fn()} />);

    expect(screen.getByText(/claude setup-token/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save Claude subscription" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Login with Claude" }),
    ).toBeNull();
  });

  it("shows the OAuth flow for Claude subscriptions", async () => {
    useAppMock.mockReturnValue(
      buildAppState({
        onboardingSubscriptionTab: "oauth",
      }),
    );

    render(<ConnectionProviderDetailScreen dispatch={vi.fn()} />);

    expect(
      screen.getByText(/Requires a Claude Pro or Max subscription\./i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Login with Claude" }));

    await waitFor(() => {
      expect(startAnthropicLoginMock).toHaveBeenCalledTimes(1);
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        "https://claude.ai/oauth/authorize?state=test",
      );
    });

    const codeInput = screen.getByPlaceholderText(
      "Paste authorization code...",
    );
    fireEvent.change(codeInput, {
      target: { value: "playwright-auth-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(exchangeAnthropicCodeMock).toHaveBeenCalledWith(
        "playwright-auth-code",
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Connected to Claude")).toBeTruthy();
    });
    expect(
      screen.getByText(/Powers task agents only \(Claude Code CLI\)\./i),
    ).toBeTruthy();
  });

  it("keeps direct Anthropic API key onboarding separate from Claude subscription copy", () => {
    useAppMock.mockReturnValue(
      buildAppState({
        onboardingProvider: "anthropic",
      }),
    );

    render(<ConnectionProviderDetailScreen dispatch={vi.fn()} />);

    expect(screen.getByText("Claude API key")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.queryByText(/claude setup-token/i)).toBeNull();
    expect(
      screen.queryByText(/Powers task agents only \(Claude Code CLI\)\./i),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Login with Claude" }),
    ).toBeNull();
  });
});

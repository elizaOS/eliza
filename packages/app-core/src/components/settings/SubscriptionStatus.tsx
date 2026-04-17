import { Button, Input, Label, useTimeout } from "@elizaos/ui";
import { useCallback, useRef, useState } from "react";
import { client } from "../../api";
import {
  getStoredSubscriptionProvider,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import {
  formatSubscriptionRequestError,
  normalizeOpenAICallbackInput,
} from "../../utils/subscription-auth";

export interface SubscriptionStatusProps {
  resolvedSelectedId: string | null;
  subscriptionStatus: Array<{
    provider: string;
    configured: boolean;
    valid: boolean;
    expiresAt: number | null;
  }>;
  anthropicConnected: boolean;
  setAnthropicConnected: (v: boolean) => void;
  openaiConnected: boolean;
  setOpenaiConnected: (v: boolean) => void;
  handleSelectSubscription: (
    providerId: SubscriptionProviderSelectionId,
    activate?: boolean,
  ) => Promise<void>;
  loadSubscriptionStatus: () => Promise<void>;
}

export function SubscriptionStatus({
  resolvedSelectedId,
  subscriptionStatus,
  anthropicConnected,
  setAnthropicConnected,
  openaiConnected,
  setOpenaiConnected,
  handleSelectSubscription,
  loadSubscriptionStatus,
}: SubscriptionStatusProps) {
  const { setTimeout } = useTimeout();

  const { t } = useApp();
  const [subscriptionTab, setSubscriptionTab] = useState<"token" | "oauth">(
    "token",
  );
  const [setupTokenValue, setSetupTokenValue] = useState("");
  const [setupTokenSaving, setSetupTokenSaving] = useState(false);
  const setupTokenRef = useRef(setupTokenValue);
  setupTokenRef.current = setupTokenValue;
  const savingRef = useRef(setupTokenSaving);
  savingRef.current = setupTokenSaving;
  const [setupTokenSuccess, setSetupTokenSuccess] = useState(false);
  const [anthropicOAuthStarted, setAnthropicOAuthStarted] = useState(false);
  const [anthropicCode, setAnthropicCode] = useState("");
  const anthropicCodeRef = useRef(anthropicCode);
  anthropicCodeRef.current = anthropicCode;
  const [anthropicError, setAnthropicError] = useState("");
  const [anthropicExchangeBusy, setAnthropicExchangeBusy] = useState(false);
  const anthropicExchangeBusyRef = useRef(false);
  const [openaiOAuthStarted, setOpenaiOAuthStarted] = useState(false);
  const [openaiCallbackUrl, setOpenaiCallbackUrl] = useState("");
  const openaiCallbackRef = useRef(openaiCallbackUrl);
  openaiCallbackRef.current = openaiCallbackUrl;
  const [openaiError, setOpenaiError] = useState("");
  const [openaiExchangeBusy, setOpenaiExchangeBusy] = useState(false);
  const openaiExchangeBusyRef = useRef(false);
  const [subscriptionDisconnecting, setSubscriptionDisconnecting] = useState<
    string | null
  >(null);
  const disconnectingRef = useRef(subscriptionDisconnecting);
  disconnectingRef.current = subscriptionDisconnecting;

  const anthropicStatus = subscriptionStatus.find(
    (s) => s.provider === "anthropic-subscription",
  );
  const openaiStatus = subscriptionStatus.find(
    (s) =>
      s.provider === "openai-subscription" || s.provider === "openai-codex",
  );

  const handleSaveSetupToken = useCallback(async () => {
    if (!setupTokenRef.current.trim() || savingRef.current) return;
    setSetupTokenSaving(true);
    setSetupTokenSuccess(false);
    setAnthropicError("");
    try {
      const result = await client.submitAnthropicSetupToken(
        setupTokenRef.current.trim(),
      );
      if (!result.success) {
        setAnthropicError(t("subscriptionstatus.FailedToSaveSetupToken"));
        return;
      }
      setSetupTokenSuccess(true);
      setSetupTokenValue("");
      await handleSelectSubscription("anthropic-subscription");
      await loadSubscriptionStatus();
      await client.restartAgent();
      setTimeout(() => setSetupTokenSuccess(false), 2000);
    } catch (err) {
      setAnthropicError(
        t("subscriptionstatus.FailedToSaveTokenError", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    } finally {
      setSetupTokenSaving(false);
    }
  }, [handleSelectSubscription, loadSubscriptionStatus, setTimeout, t]);

  const handleDisconnectSubscription = useCallback(
    async (providerId: SubscriptionProviderSelectionId) => {
      if (disconnectingRef.current) return;
      setSubscriptionDisconnecting(providerId);
      setAnthropicError("");
      setOpenaiError("");
      try {
        await client.deleteSubscription(
          getStoredSubscriptionProvider(providerId),
        );
        await loadSubscriptionStatus();
        if (providerId === "anthropic-subscription") {
          setAnthropicConnected(false);
          setAnthropicOAuthStarted(false);
          setAnthropicCode("");
        }
        if (providerId === "openai-subscription") {
          setOpenaiConnected(false);
          setOpenaiOAuthStarted(false);
          setOpenaiCallbackUrl("");
        }
        await client.restartAgent();
      } catch (err) {
        const msg = t("subscriptionstatus.DisconnectFailedError", {
          message: formatSubscriptionRequestError(err),
        });
        if (providerId === "anthropic-subscription") setAnthropicError(msg);
        if (providerId === "openai-subscription") setOpenaiError(msg);
      } finally {
        setSubscriptionDisconnecting(null);
      }
    },
    [loadSubscriptionStatus, setAnthropicConnected, setOpenaiConnected, t],
  );

  const handleAnthropicStart = useCallback(async () => {
    setAnthropicError("");
    try {
      const { authUrl } = await client.startAnthropicLogin();
      if (authUrl) {
        await openExternalUrl(authUrl);
        setAnthropicOAuthStarted(true);
        return;
      }
      setAnthropicError(t("subscriptionstatus.FailedToGetAuthUrl"));
    } catch (err) {
      setAnthropicError(
        t("subscriptionstatus.FailedToStartLogin", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    }
  }, [t]);

  const handleAnthropicExchange = useCallback(async () => {
    const code = anthropicCodeRef.current.trim();
    if (!code || anthropicExchangeBusyRef.current) return;
    anthropicExchangeBusyRef.current = true;
    setAnthropicExchangeBusy(true);
    setAnthropicError("");
    try {
      const result = await client.exchangeAnthropicCode(code);
      if (result.success) {
        setAnthropicConnected(true);
        setAnthropicOAuthStarted(false);
        setAnthropicCode("");
        await handleSelectSubscription("anthropic-subscription");
        await loadSubscriptionStatus();
        await client.restartAgent();
        return;
      }
      setAnthropicError(result.error ?? t("subscriptionstatus.ExchangeFailed"));
    } catch (err) {
      setAnthropicError(
        t("subscriptionstatus.ExchangeFailedError", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    } finally {
      anthropicExchangeBusyRef.current = false;
      setAnthropicExchangeBusy(false);
    }
  }, [
    handleSelectSubscription,
    loadSubscriptionStatus,
    setAnthropicConnected,
    t,
  ]);

  const handleOpenAIStart = useCallback(async () => {
    setOpenaiError("");
    try {
      const { authUrl } = await client.startOpenAILogin();
      if (authUrl) {
        await openExternalUrl(authUrl);
        setOpenaiOAuthStarted(true);
        return;
      }
      setOpenaiError(t("subscriptionstatus.NoAuthUrlReturned"));
    } catch (err) {
      setOpenaiError(
        t("subscriptionstatus.FailedToStartLogin", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    }
  }, [t]);

  const handleOpenAIExchange = useCallback(async () => {
    if (openaiExchangeBusyRef.current) return;
    const normalized = normalizeOpenAICallbackInput(openaiCallbackRef.current);
    if (normalized.ok === false) {
      setOpenaiError(t(normalized.error));
      return;
    }

    openaiExchangeBusyRef.current = true;
    setOpenaiExchangeBusy(true);
    setOpenaiError("");
    try {
      const data = await client.exchangeOpenAICode(normalized.code);
      if (data.success) {
        setOpenaiConnected(true);
        setOpenaiOAuthStarted(false);
        setOpenaiCallbackUrl("");
        await handleSelectSubscription("openai-subscription");
        await loadSubscriptionStatus();
        await client.restartAgent();
        return;
      }
      const msg = data.error ?? t("subscriptionstatus.ExchangeFailed");
      setOpenaiError(
        msg.includes("No active flow")
          ? t("onboarding.loginSessionExpired")
          : msg,
      );
    } catch (err) {
      setOpenaiError(
        t("subscriptionstatus.ExchangeFailedError", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    } finally {
      openaiExchangeBusyRef.current = false;
      setOpenaiExchangeBusy(false);
    }
  }, [handleSelectSubscription, loadSubscriptionStatus, setOpenaiConnected, t]);

  return (
    <div className="mt-4 pt-4">
      {resolvedSelectedId === "anthropic-subscription" && (
        <div>
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${anthropicConnected ? "bg-ok" : "bg-warn"}`}
              />
              <span className="text-xs font-semibold">
                {anthropicConnected
                  ? t("subscriptionstatus.ConnectedToClaudeSubscription")
                  : t("subscriptionstatus.ClaudeSubscriptionTitle")}
              </span>
            </div>
            {anthropicConnected && (
              <Button
                variant="outline"
                size="sm"
                className="!mt-0"
                onClick={() =>
                  void handleDisconnectSubscription("anthropic-subscription")
                }
                disabled={
                  subscriptionDisconnecting === "anthropic-subscription"
                }
              >
                {subscriptionDisconnecting === "anthropic-subscription"
                  ? t("providerswitcher.disconnecting")
                  : t("providerswitcher.disconnect")}
              </Button>
            )}
          </div>

          {/* TOS restriction warning — Claude subscription tokens can only
              be used through the Claude Code CLI, not for direct API calls. */}
          <div className="text-xs leading-relaxed p-2.5 mb-3 border border-warn/30 bg-warn/5 rounded">
            <span className="font-semibold">
              {t("subscriptionstatus.ClaudeTosWarningShort")}
            </span>
          </div>

          {anthropicStatus?.configured && !anthropicStatus.valid && (
            <div className="text-xs text-warn mb-3">
              {t("subscriptionstatus.ClaudeSubscription")}
            </div>
          )}

          <div className="flex items-center gap-4 mb-3">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className={`text-xs pb-2 border-b-2 rounded-none ${
                subscriptionTab === "token"
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-txt"
              }`}
              onClick={() => setSubscriptionTab("token")}
            >
              {t("onboarding.setupToken")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className={`text-xs pb-2 border-b-2 rounded-none ${
                subscriptionTab === "oauth"
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-txt"
              }`}
              onClick={() => setSubscriptionTab("oauth")}
            >
              {t("onboarding.oauthLogin")}
            </Button>
          </div>

          {subscriptionTab === "token" ? (
            <div>
              <Label
                htmlFor="subscription-setup-token-input"
                className="text-xs font-semibold mb-1.5 block"
              >
                {t("onboarding.setupToken")}
              </Label>
              <Input
                id="subscription-setup-token-input"
                type="password"
                placeholder={t("subscriptionstatus.skAntOat01")}
                value={setupTokenValue}
                onChange={(e) => {
                  setSetupTokenValue(e.target.value);
                  setSetupTokenSuccess(false);
                  setAnthropicError("");
                }}
                className="bg-card text-xs font-mono"
              />
              <div className="text-xs-tight text-muted mt-2 whitespace-pre-line">
                {t("onboarding.setupTokenInstructions")}
              </div>
              {anthropicError && (
                <div className="text-xs-tight text-danger mt-2">
                  {anthropicError}
                </div>
              )}
              <div className="flex items-center justify-between mt-3">
                <Button
                  variant="default"
                  size="sm"
                  className="!mt-0"
                  disabled={setupTokenSaving || !setupTokenValue.trim()}
                  onClick={() => void handleSaveSetupToken()}
                >
                  {setupTokenSaving
                    ? t("apikeyconfig.saving")
                    : t("subscriptionstatus.SaveToken")}
                </Button>
                <div className="flex items-center gap-2">
                  {setupTokenSaving && (
                    <span className="text-xs-tight text-muted">
                      {t("subscriptionstatus.SavingAmpRestart")}
                    </span>
                  )}
                  {setupTokenSuccess && (
                    <span className="text-xs-tight text-ok">
                      {t("apikeyconfig.saved")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : anthropicConnected ? (
            <div className="text-xs text-muted">
              {t("subscriptionstatus.YourClaudeSubscrip")}
            </div>
          ) : !anthropicOAuthStarted ? (
            <div>
              <Button
                variant="default"
                size="sm"
                className="!mt-0"
                onClick={() => void handleAnthropicStart()}
              >
                {t("onboarding.loginWithAnthropic")}
              </Button>
              <div className="text-xs-tight text-muted mt-1.5">
                {t("subscriptionstatus.RequiresClaudePro")}
              </div>
              {anthropicError && (
                <div className="text-xs-tight text-danger mt-2">
                  {anthropicError}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="text-xs text-muted mb-2">
                {t("subscriptionstatus.AfterLoggingInCo")}
              </div>
              <Input
                type="text"
                placeholder={t("subscriptionstatus.PasteTheAuthorizat")}
                value={anthropicCode}
                onChange={(e) => {
                  setAnthropicCode(e.target.value);
                  setAnthropicError("");
                }}
                className="bg-card text-xs"
              />
              {anthropicError && (
                <div className="text-xs-tight text-danger mt-2">
                  {anthropicError}
                </div>
              )}
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="default"
                  size="sm"
                  className="!mt-0"
                  disabled={anthropicExchangeBusy || !anthropicCode.trim()}
                  onClick={() => void handleAnthropicExchange()}
                >
                  {anthropicExchangeBusy
                    ? t("onboarding.connecting")
                    : t("onboarding.connect")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="!mt-0"
                  onClick={() => {
                    setAnthropicOAuthStarted(false);
                    setAnthropicCode("");
                    setAnthropicError("");
                  }}
                >
                  {t("onboarding.startOver")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {resolvedSelectedId === "openai-subscription" && (
        <div>
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${openaiConnected ? "bg-ok" : "bg-warn"}`}
              />
              <span className="text-xs font-semibold">
                {openaiConnected
                  ? t("subscriptionstatus.ConnectedToChatGPTSubscription")
                  : t("subscriptionstatus.ChatGPTSubscriptionTitle")}
              </span>
            </div>
            {openaiConnected && (
              <Button
                variant="outline"
                size="sm"
                className="!mt-0"
                onClick={() =>
                  void handleDisconnectSubscription("openai-subscription")
                }
                disabled={subscriptionDisconnecting === "openai-subscription"}
              >
                {subscriptionDisconnecting === "openai-subscription"
                  ? t("providerswitcher.disconnecting")
                  : t("providerswitcher.disconnect")}
              </Button>
            )}
          </div>

          {openaiConnected && (
            <div className="text-xs leading-relaxed p-2.5 mb-3 border border-ok/30 bg-ok/5 rounded">
              {t("subscriptionstatus.CodexAllAccess")}
            </div>
          )}

          {openaiStatus?.configured && !openaiStatus.valid && (
            <div className="text-xs text-warn mb-3">
              {t("subscriptionstatus.ChatGPTSubscription")}
            </div>
          )}

          {openaiConnected ? (
            <div className="text-xs text-muted">
              {t("subscriptionstatus.YourChatGPTSubscri")}
            </div>
          ) : !openaiOAuthStarted ? (
            <div>
              <Button
                variant="default"
                size="sm"
                className="!mt-0"
                onClick={() => void handleOpenAIStart()}
              >
                {t("onboarding.loginWithOpenAI")}
              </Button>
              <div className="text-xs-tight text-muted mt-1.5">
                {t("subscriptionstatus.RequiresChatGPTPlu")}
              </div>
            </div>
          ) : (
            <div>
              <div className="p-2.5 border border-border bg-bg text-xs-tight text-muted leading-relaxed">
                {t("subscriptionstatus.AfterLoggingInYo")}{" "}
                <code className="text-2xs px-1 border border-border bg-card">
                  {t("subscriptionstatus.localhost1455")}
                </code>
                {t("subscriptionstatus.CopyTheEntireU")}
              </div>
              <Input
                type="text"
                className="mt-2 bg-card text-xs"
                placeholder={t("subscriptionstatus.httpLocalhost145")}
                value={openaiCallbackUrl}
                onChange={(e) => {
                  setOpenaiCallbackUrl(e.target.value);
                  setOpenaiError("");
                }}
              />
              {openaiError && (
                <div className="text-xs-tight text-danger mt-2">
                  {openaiError}
                </div>
              )}
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="default"
                  size="sm"
                  className="!mt-0"
                  disabled={openaiExchangeBusy || !openaiCallbackUrl.trim()}
                  onClick={() => void handleOpenAIExchange()}
                >
                  {openaiExchangeBusy
                    ? t("subscriptionstatus.Completing")
                    : t("onboarding.completeLogin")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="!mt-0"
                  onClick={() => {
                    setOpenaiOAuthStarted(false);
                    setOpenaiCallbackUrl("");
                    setOpenaiError("");
                  }}
                >
                  {t("onboarding.startOver")}
                </Button>
              </div>
            </div>
          )}

          {openaiError && !openaiOAuthStarted && (
            <div className="text-xs-tight text-danger mt-2">{openaiError}</div>
          )}
        </div>
      )}
    </div>
  );
}

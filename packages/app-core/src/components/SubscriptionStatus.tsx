/**
 * SubscriptionStatus — Anthropic and OpenAI subscription connection panels.
 *
 * Extracted from SettingsView.tsx for decomposition (P2 §10).
 */

import { Button, Input } from "@elizaos/ui";
import { useCallback, useRef, useState } from "react";
import { client } from "../api";
import { useTimeout } from "../hooks";
import {
  getStoredSubscriptionProvider,
  type SubscriptionProviderSelectionId,
} from "../providers";
import { useApp } from "../state";
import { openExternalUrl } from "../utils";

function formatRequestError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeOpenAICallbackInput(input: string):
  | {
      ok: true;
      code: string;
    }
  | {
      ok: false;
      error: string;
    } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    };
  }

  const normalized =
    trimmed.startsWith("localhost:") || trimmed.startsWith("127.0.0.1:")
      ? `http://${trimmed}`
      : trimmed;

  // Allow raw codes in addition to full callback URLs.
  if (!normalized.includes("://")) {
    if (normalized.length > 4096) {
      return { ok: false, error: "subscriptionstatus.CallbackCodeTooLong" };
    }
    return { ok: true, code: normalized };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "subscriptionstatus.InvalidCallbackUrl" };
  }

  const hostOk =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    !hostOk ||
    parsed.port !== "1455" ||
    parsed.pathname !== "/auth/callback"
  ) {
    return {
      ok: false,
      error: "subscriptionstatus.ExpectedCallbackUrl",
    };
  }
  if (!parsed.searchParams.get("code")) {
    return {
      ok: false,
      error: "subscriptionstatus.CallbackUrlMissingCode",
    };
  }
  return { ok: true, code: normalized };
}

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
          message: formatRequestError(err),
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
          message: formatRequestError(err),
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
          message: formatRequestError(err),
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
          message: formatRequestError(err),
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
          message: formatRequestError(err),
        }),
      );
    }
  }, [t]);

  const handleOpenAIExchange = useCallback(async () => {
    if (openaiExchangeBusyRef.current) return;
    const normalized = normalizeOpenAICallbackInput(openaiCallbackRef.current);
    if (!normalized.ok) {
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
      console.warn("[eliza] OpenAI exchange failed", err);
      setOpenaiError(t("onboarding.networkError"));
    } finally {
      openaiExchangeBusyRef.current = false;
      setOpenaiExchangeBusy(false);
    }
  }, [handleSelectSubscription, loadSubscriptionStatus, setOpenaiConnected, t]);

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]">
      {resolvedSelectedId === "anthropic-subscription" && (
        <div>
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{
                  background: anthropicConnected
                    ? "var(--ok,#16a34a)"
                    : "var(--warning,#f39c12)",
                }}
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
                  ? t("subscriptionstatus.Disconnecting")
                  : t("subscriptionstatus.Disconnect")}
              </Button>
            )}
          </div>

          {anthropicStatus?.configured && !anthropicStatus.valid && (
            <div className="text-xs text-[var(--warning,#f39c12)] mb-3">
              {t("subscriptionstatus.ClaudeSubscription")}
            </div>
          )}

          <div className="flex items-center gap-4 border-b border-[var(--border)] mb-3">
            <button
              type="button"
              className={`text-xs pb-2 border-b-2 ${
                subscriptionTab === "token"
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
              }`}
              onClick={() => setSubscriptionTab("token")}
            >
              {t("subscriptionstatus.SetupToken")}
            </button>
            <button
              type="button"
              className={`text-xs pb-2 border-b-2 ${
                subscriptionTab === "oauth"
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
              }`}
              onClick={() => setSubscriptionTab("oauth")}
            >
              {t("subscriptionstatus.OAuthLogin")}
            </button>
          </div>

          {subscriptionTab === "token" ? (
            <div>
              <label
                htmlFor="subscription-setup-token-input"
                className="text-xs font-semibold mb-1.5 block"
              >
                {t("subscriptionstatus.SetupToken")}
              </label>
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
              <div className="text-[11px] text-[var(--muted)] mt-2 whitespace-pre-line">
                {t("onboarding.setupTokenInstructions")}
              </div>
              {anthropicError && (
                <div className="text-[11px] text-[var(--danger,#e74c3c)] mt-2">
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
                    ? t("subscriptionstatus.Saving")
                    : t("subscriptionstatus.SaveToken")}
                </Button>
                <div className="flex items-center gap-2">
                  {setupTokenSaving && (
                    <span className="text-[11px] text-[var(--muted)]">
                      {t("subscriptionstatus.SavingAmpRestart")}
                    </span>
                  )}
                  {setupTokenSuccess && (
                    <span className="text-[11px] text-[var(--ok,#16a34a)]">
                      {t("messagecontent.Saved")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : anthropicConnected ? (
            <div className="text-xs text-[var(--muted)]">
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
              <div className="text-[11px] text-[var(--muted)] mt-1.5">
                {t("subscriptionstatus.RequiresClaudePro")}
              </div>
              {anthropicError && (
                <div className="text-[11px] text-[var(--danger,#e74c3c)] mt-2">
                  {anthropicError}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="text-xs text-[var(--muted)] mb-2">
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
                <div className="text-[11px] text-[var(--danger,#e74c3c)] mt-2">
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
                className="inline-block w-2 h-2 rounded-full"
                style={{
                  background: openaiConnected
                    ? "var(--ok,#16a34a)"
                    : "var(--warning,#f39c12)",
                }}
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
                  ? t("subscriptionstatus.Disconnecting")
                  : t("subscriptionstatus.Disconnect")}
              </Button>
            )}
          </div>

          {openaiStatus?.configured && !openaiStatus.valid && (
            <div className="text-xs text-[var(--warning,#f39c12)] mb-3">
              {t("subscriptionstatus.ChatGPTSubscription")}
            </div>
          )}

          {openaiConnected ? (
            <div className="text-xs text-[var(--muted)]">
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
                {t("subscriptionstatus.LoginWithOpenAI")}
              </Button>
              <div className="text-[11px] text-[var(--muted)] mt-1.5">
                {t("subscriptionstatus.RequiresChatGPTPlu")}
              </div>
            </div>
          ) : (
            <div>
              <div className="p-2.5 border border-[var(--border)] bg-[var(--bg-muted)] text-[11px] text-[var(--muted)] leading-relaxed">
                {t("subscriptionstatus.AfterLoggingInYo")}{" "}
                <code className="text-[10px] px-1 border border-[var(--border)] bg-[var(--card)]">
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
                <div className="text-[11px] text-[var(--danger,#e74c3c)] mt-2">
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
                  }}
                >
                  {t("onboarding.startOver")}
                </Button>
              </div>
            </div>
          )}

          {openaiError && !openaiOAuthStarted && (
            <div className="text-[11px] text-[var(--danger,#e74c3c)] mt-2">
              {openaiError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

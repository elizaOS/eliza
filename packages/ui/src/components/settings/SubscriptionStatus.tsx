import { AlertTriangle, CheckCircle2, Loader2, LogOut } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import { useTimeout } from "../../hooks/useTimeout";
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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface SubscriptionStatusProps {
  resolvedSelectedId: string | null;
  subscriptionStatus: Array<{
    provider: string;
    accountId: string;
    label: string;
    configured: boolean;
    valid: boolean;
    expiresAt: number | null;
    source?:
      | "app"
      | "claude-code-cli"
      | "setup-token"
      | "codex-cli"
      | "gemini-cli"
      | "coding-plan-key"
      | "unavailable"
      | null;
    available?: boolean;
    availabilityReason?: string;
    allowedClient?: string;
    loginHint?: string;
    billingMode?: "subscription-coding-plan" | "subscription-coding-cli";
  }>;
  anthropicConnected: boolean;
  setAnthropicConnected: (v: boolean) => void;
  /**
   * True when Claude Code CLI credentials exist on this machine but the user
   * has NOT linked their subscription via the in-app OAuth flow. In this
   * state the panel shows a read-only notice and hides the Disconnect
   * button — the app can't clear CLI-owned credentials.
   */
  anthropicCliDetected: boolean;
  openaiConnected: boolean;
  setOpenaiConnected: (v: boolean) => void;
  handleSelectSubscription: (
    providerId: SubscriptionProviderSelectionId,
    activate?: boolean,
  ) => Promise<void>;
  loadSubscriptionStatus: () => Promise<void>;
}

type SubscriptionStatusRow =
  SubscriptionStatusProps["subscriptionStatus"][number];

function selectRepresentativeSubscriptionStatus(
  rows: SubscriptionStatusRow[],
): SubscriptionStatusRow | null {
  return (
    rows.find((status) => status.configured && status.valid) ??
    rows.find((status) => status.configured) ??
    rows.find((status) => status.available === false) ??
    rows[0] ??
    null
  );
}

interface SubscriptionProviderPanelProps {
  providerId: SubscriptionProviderSelectionId;
  connected: boolean;
  /**
   * Whether this panel owns credentials it can actually delete via
   * `DELETE /api/subscription/{provider}`. When false (e.g. Claude Code CLI
   * credentials detected on disk), the Disconnect button is hidden since
   * clicking it would be a no-op and just confuse the user.
   */
  canDisconnect?: boolean;
  /** Optional notice rendered below the header (e.g. for CLI-detected state). */
  externalNotice?: ReactNode;
  configuredButInvalid: boolean;
  titleConnected: string;
  titleDisconnected: string;
  loginLabel: string;
  loginHint: string;
  /** Provider-specific paragraph shown when connected (replaces the OAuth body). */
  connectedSummary: string;
  /** Provider-specific message shown when configured but token is invalid. */
  invalidWarning: string;
  noteWhenConnected?: ReactNode;
  warningBanner?: ReactNode;
  /** Slot to render content above the OAuth shell (e.g. tab switcher). */
  preOauthSlot?: ReactNode;
  /** Slot for provider-specific instructions inside the in-progress OAuth state. */
  oauthInstructions: ReactNode;
  oauthInputPlaceholder: string;
  oauthInputType?: "text" | "password";
  oauthCode: string;
  setOauthCode: (v: string) => void;
  oauthStarted: boolean;
  oauthError: string;
  oauthExchangeBusy: boolean;
  exchangeButtonLabel: string;
  exchangeBusyLabel: string;
  disconnecting: boolean;
  onStartOauth: () => void;
  onExchange: () => void;
  onResetFlow: () => void;
  onDisconnect: () => void;
  /** Optional content rendered in place of the OAuth shell (used by Anthropic's token tab). */
  bodyOverride?: ReactNode;
}

function StatusIcon({ connected }: { connected: boolean }) {
  return (
    <span className={connected ? "text-ok" : "text-warn"}>
      {connected ? (
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      )}
    </span>
  );
}

function SubscriptionProviderPanel({
  connected,
  canDisconnect = true,
  externalNotice,
  configuredButInvalid,
  titleConnected,
  titleDisconnected,
  loginLabel,
  loginHint,
  connectedSummary,
  invalidWarning,
  noteWhenConnected,
  warningBanner,
  preOauthSlot,
  oauthInstructions,
  oauthInputPlaceholder,
  oauthInputType = "text",
  oauthCode,
  setOauthCode,
  oauthStarted,
  oauthError,
  oauthExchangeBusy,
  exchangeButtonLabel,
  exchangeBusyLabel,
  disconnecting,
  onStartOauth,
  onExchange,
  onResetFlow,
  onDisconnect,
  bodyOverride,
}: SubscriptionProviderPanelProps) {
  const { t } = useApp();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusIcon connected={connected} />
          <span className="text-xs font-semibold">
            {connected ? titleConnected : titleDisconnected}
          </span>
        </div>
        {connected && canDisconnect && (
          <Button
            variant="outline"
            size="icon"
            className="!mt-0 h-8 w-8 rounded-lg"
            onClick={onDisconnect}
            disabled={disconnecting}
            aria-label={t("common.disconnect")}
            title={t("common.disconnect")}
          >
            {disconnecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <LogOut className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        )}
      </div>

      {warningBanner}

      {externalNotice}

      {configuredButInvalid && (
        <div className="text-xs text-warn">{invalidWarning}</div>
      )}

      {noteWhenConnected && connected && noteWhenConnected}

      {preOauthSlot}

      {bodyOverride ??
        (connected ? (
          <p className="text-xs text-muted">{connectedSummary}</p>
        ) : !oauthStarted ? (
          <div className="space-y-1.5">
            <Button
              variant="default"
              size="sm"
              className="!mt-0 h-9 rounded-lg font-semibold"
              onClick={onStartOauth}
            >
              {loginLabel}
            </Button>
            <p className="text-xs-tight text-muted">{loginHint}</p>
            {oauthError && (
              <p className="text-xs-tight text-danger">{oauthError}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {oauthInstructions}
            <Input
              type={oauthInputType}
              className="h-9 rounded-lg bg-card text-xs"
              placeholder={oauthInputPlaceholder}
              value={oauthCode}
              onChange={(e) => setOauthCode(e.target.value)}
            />
            {oauthError && (
              <p className="text-xs-tight text-danger">{oauthError}</p>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="!mt-0 h-9 rounded-lg font-semibold"
                disabled={oauthExchangeBusy || !oauthCode.trim()}
                onClick={onExchange}
              >
                {oauthExchangeBusy ? exchangeBusyLabel : exchangeButtonLabel}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="!mt-0 h-9 rounded-lg"
                onClick={onResetFlow}
              >
                {t("onboarding.startOver")}
              </Button>
            </div>
          </div>
        ))}
    </div>
  );
}

export function SubscriptionStatus({
  resolvedSelectedId,
  subscriptionStatus,
  anthropicConnected,
  setAnthropicConnected,
  anthropicCliDetected,
  openaiConnected,
  setOpenaiConnected,
  handleSelectSubscription,
  loadSubscriptionStatus,
}: SubscriptionStatusProps) {
  const { setTimeout } = useTimeout();
  const { t } = useApp();

  /* ── Anthropic ─────────────────────────────────────────────────── */
  const [subscriptionTab, setSubscriptionTab] = useState<"token" | "oauth">(
    "token",
  );
  const [setupTokenValue, setSetupTokenValue] = useState("");
  const [setupTokenSaving, setSetupTokenSaving] = useState(false);
  const [setupTokenSuccess, setSetupTokenSuccess] = useState(false);
  const [anthropicOAuthStarted, setAnthropicOAuthStarted] = useState(false);
  const [anthropicCode, setAnthropicCode] = useState("");
  const [anthropicError, setAnthropicError] = useState("");
  const [anthropicExchangeBusy, setAnthropicExchangeBusy] = useState(false);

  /* ── OpenAI ────────────────────────────────────────────────────── */
  const [openaiOAuthStarted, setOpenaiOAuthStarted] = useState(false);
  const [openaiCallbackUrl, setOpenaiCallbackUrl] = useState("");
  const [openaiError, setOpenaiError] = useState("");
  const [openaiExchangeBusy, setOpenaiExchangeBusy] = useState(false);

  /* ── Shared disconnect lock ────────────────────────────────────── */
  const [subscriptionDisconnecting, setSubscriptionDisconnecting] = useState<
    string | null
  >(null);
  const disconnectingRef = useRef(subscriptionDisconnecting);
  useEffect(() => {
    disconnectingRef.current = subscriptionDisconnecting;
  }, [subscriptionDisconnecting]);

  const anthropicStatuses = subscriptionStatus.filter(
    (s) => s.provider === "anthropic-subscription",
  );
  const anthropicStatus =
    selectRepresentativeSubscriptionStatus(anthropicStatuses);
  const openaiStatuses = subscriptionStatus.filter(
    (s) =>
      s.provider === "openai-subscription" || s.provider === "openai-codex",
  );
  const openaiStatus = selectRepresentativeSubscriptionStatus(openaiStatuses);

  /* ── Shared disconnect ─────────────────────────────────────────── */
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

  /* ── Anthropic handlers ────────────────────────────────────────── */
  const handleSaveSetupToken = useCallback(async () => {
    const code = setupTokenValue.trim();
    if (!code || setupTokenSaving) return;
    setSetupTokenSaving(true);
    setSetupTokenSuccess(false);
    setAnthropicError("");
    try {
      const result = await client.submitAnthropicSetupToken(code);
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
  }, [
    handleSelectSubscription,
    loadSubscriptionStatus,
    setTimeout,
    setupTokenSaving,
    setupTokenValue,
    t,
  ]);

  const handleAnthropicStart = useCallback(async () => {
    setAnthropicError("");
    try {
      const { authUrl } = await client.startAnthropicLogin();
      if (authUrl) {
        await openExternalUrl(authUrl);
        setAnthropicOAuthStarted(true);
        return;
      }
      setAnthropicError(t("onboarding.failedToGetAuthUrl"));
    } catch (err) {
      setAnthropicError(
        t("onboarding.failedToStartLogin", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    }
  }, [t]);

  const handleAnthropicExchange = useCallback(async () => {
    const code = anthropicCode.trim();
    if (!code || anthropicExchangeBusy) return;
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
      setAnthropicError(result.error ?? t("onboarding.exchangeFailed"));
    } catch (err) {
      setAnthropicError(
        t("onboarding.exchangeFailedWithMessage", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    } finally {
      setAnthropicExchangeBusy(false);
    }
  }, [
    anthropicCode,
    anthropicExchangeBusy,
    handleSelectSubscription,
    loadSubscriptionStatus,
    setAnthropicConnected,
    t,
  ]);

  /* ── OpenAI handlers ───────────────────────────────────────────── */
  const handleOpenAIStart = useCallback(async () => {
    setOpenaiError("");
    try {
      const { authUrl } = await client.startOpenAILogin();
      if (authUrl) {
        await openExternalUrl(authUrl);
        setOpenaiOAuthStarted(true);
        return;
      }
      setOpenaiError(t("onboarding.noAuthUrlReturned"));
    } catch (err) {
      setOpenaiError(
        t("onboarding.failedToStartLogin", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    }
  }, [t]);

  const handleOpenAIExchange = useCallback(async () => {
    if (openaiExchangeBusy) return;
    const normalized = normalizeOpenAICallbackInput(openaiCallbackUrl);
    if (normalized.ok === false) {
      setOpenaiError(t(normalized.error));
      return;
    }

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
      const msg = data.error ?? t("onboarding.exchangeFailed");
      setOpenaiError(
        msg.includes("No active flow")
          ? t("onboarding.loginSessionExpired")
          : msg,
      );
    } catch (err) {
      setOpenaiError(
        t("onboarding.exchangeFailedWithMessage", {
          message: formatSubscriptionRequestError(err),
        }),
      );
    } finally {
      setOpenaiExchangeBusy(false);
    }
  }, [
    handleSelectSubscription,
    loadSubscriptionStatus,
    openaiCallbackUrl,
    openaiExchangeBusy,
    setOpenaiConnected,
    t,
  ]);

  /* ── Anthropic token tab body ──────────────────────────────────── */
  const tokenTabBody = (
    <div className="space-y-2">
      <Label
        htmlFor="subscription-setup-token-input"
        className="text-xs font-semibold"
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
        className="h-9 rounded-lg bg-card font-mono text-xs"
      />
      <p className="whitespace-pre-line text-xs-tight text-muted">
        {t("onboarding.setupTokenInstructions")}
      </p>
      {anthropicError && (
        <p className="text-xs-tight text-danger">{anthropicError}</p>
      )}
      <div className="flex items-center justify-between">
        <Button
          variant="default"
          size="sm"
          className="!mt-0 h-9 rounded-lg font-semibold"
          disabled={setupTokenSaving || !setupTokenValue.trim()}
          onClick={() => void handleSaveSetupToken()}
        >
          {setupTokenSaving
            ? t("common.saving")
            : t("subscriptionstatus.SaveToken")}
        </Button>
        <div className="flex items-center gap-2">
          {setupTokenSaving && (
            <span className="text-xs-tight text-muted">
              {t("subscriptionstatus.SavingAmpRestart")}
            </span>
          )}
          {setupTokenSuccess && (
            <span className="text-xs-tight text-ok">{t("common.saved")}</span>
          )}
        </div>
      </div>
    </div>
  );

  /* ── Anthropic tab switcher (only when not connected) ──────────── */
  const anthropicTabs = !anthropicConnected ? (
    <div className="flex items-center gap-4 border-b border-border/40">
      {(
        [
          ["token", t("onboarding.setupToken")],
          ["oauth", t("onboarding.oauthLogin")],
        ] as const
      ).map(([id, label]) => {
        const active = subscriptionTab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setSubscriptionTab(id)}
            className={`-mb-px border-b-2 px-1 pb-2 text-xs font-medium transition-colors ${
              active
                ? "border-accent text-txt"
                : "border-transparent text-muted hover:text-txt"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  ) : undefined;

  /* ── OpenAI callback instructions ──────────────────────────────── */
  const openaiInstructions = (
    <div className="rounded-lg border border-border/40 bg-bg/40 px-3 py-2 text-xs-tight leading-relaxed text-muted">
      {t("subscriptionstatus.AfterLoggingInYo")}{" "}
      <code className="rounded border border-border bg-card px-1 text-2xs">
        {t("subscriptionstatus.localhost1455")}
      </code>
      {t("subscriptionstatus.CopyTheEntireU")}
    </div>
  );

  const genericStoredProvider =
    resolvedSelectedId &&
    resolvedSelectedId !== "anthropic-subscription" &&
    resolvedSelectedId !== "openai-subscription"
      ? getStoredSubscriptionProvider(
          resolvedSelectedId as SubscriptionProviderSelectionId,
        )
      : null;
  const genericStatuses = genericStoredProvider
    ? subscriptionStatus.filter(
        (status) => status.provider === genericStoredProvider,
      )
    : [];
  const genericStatus = selectRepresentativeSubscriptionStatus(genericStatuses);

  return (
    <div className="border-t border-border/40 pt-4">
      {resolvedSelectedId === "anthropic-subscription" && (
        <SubscriptionProviderPanel
          providerId="anthropic-subscription"
          connected={anthropicConnected}
          canDisconnect={false}
          externalNotice={
            anthropicCliDetected && !anthropicConnected ? (
              <div className="rounded-lg border border-border/40 bg-card/40 px-2.5 py-2 text-xs leading-relaxed">
                <div className="font-semibold">
                  {t("subscriptionstatus.ClaudeCodeCliDetectedTitle")}
                </div>
                <p className="mt-1 text-muted">
                  {t("subscriptionstatus.ClaudeCodeCliDetectedBody")}
                </p>
              </div>
            ) : undefined
          }
          configuredButInvalid={Boolean(
            anthropicStatus?.configured && !anthropicStatus.valid,
          )}
          titleConnected={t("subscriptionstatus.ConnectedToClaudeSubscription")}
          titleDisconnected={
            anthropicCliDetected
              ? t("subscriptionstatus.ClaudeCodeCliDetectedTitle")
              : t("subscriptionstatus.ClaudeSubscriptionTitle")
          }
          loginLabel={t("onboarding.loginWithAnthropic")}
          loginHint={t("subscriptionstatus.RequiresClaudePro")}
          connectedSummary={t("subscriptionstatus.YourClaudeSubscrip")}
          invalidWarning={t("subscriptionstatus.ClaudeSubscription")}
          warningBanner={
            <div className="rounded-lg border border-warn/30 bg-warn/5 px-2.5 py-2 text-xs leading-relaxed">
              <span className="font-semibold">
                {t("subscriptionstatus.ClaudeTosWarningShort")}
              </span>
            </div>
          }
          preOauthSlot={anthropicTabs}
          oauthInstructions={
            <p className="text-xs text-muted">
              {t("subscriptionstatus.AfterLoggingInCo")}
            </p>
          }
          oauthInputPlaceholder={t("subscriptionstatus.PasteTheAuthorizat")}
          oauthCode={anthropicCode}
          setOauthCode={(v) => {
            setAnthropicCode(v);
            setAnthropicError("");
          }}
          oauthStarted={anthropicOAuthStarted}
          oauthError={anthropicError}
          oauthExchangeBusy={anthropicExchangeBusy}
          exchangeButtonLabel={t("common.connect")}
          exchangeBusyLabel={t("game.connecting")}
          disconnecting={subscriptionDisconnecting === "anthropic-subscription"}
          onStartOauth={() => void handleAnthropicStart()}
          onExchange={() => void handleAnthropicExchange()}
          onResetFlow={() => {
            setAnthropicOAuthStarted(false);
            setAnthropicCode("");
            setAnthropicError("");
          }}
          onDisconnect={() =>
            void handleDisconnectSubscription("anthropic-subscription")
          }
          bodyOverride={
            !anthropicConnected && subscriptionTab === "token"
              ? tokenTabBody
              : undefined
          }
        />
      )}

      {resolvedSelectedId === "openai-subscription" && (
        <SubscriptionProviderPanel
          providerId="openai-subscription"
          connected={openaiConnected}
          canDisconnect={false}
          configuredButInvalid={Boolean(
            openaiStatus?.configured && !openaiStatus.valid,
          )}
          titleConnected={t(
            "subscriptionstatus.ConnectedToChatGPTSubscription",
          )}
          titleDisconnected={t("subscriptionstatus.ChatGPTSubscriptionTitle")}
          loginLabel={t("onboarding.loginWithOpenAI")}
          loginHint={t("subscriptionstatus.RequiresChatGPTPlu")}
          connectedSummary={t("subscriptionstatus.YourChatGPTSubscri")}
          invalidWarning={t("subscriptionstatus.ChatGPTSubscription")}
          noteWhenConnected={
            <div className="rounded-lg border border-ok/30 bg-ok/5 px-2.5 py-2 text-xs leading-relaxed">
              {t("subscriptionstatus.CodexAllAccess")}
            </div>
          }
          oauthInstructions={openaiInstructions}
          oauthInputPlaceholder={t("subscriptionstatus.httpLocalhost145")}
          oauthCode={openaiCallbackUrl}
          setOauthCode={(v) => {
            setOpenaiCallbackUrl(v);
            setOpenaiError("");
          }}
          oauthStarted={openaiOAuthStarted}
          oauthError={openaiError}
          oauthExchangeBusy={openaiExchangeBusy}
          exchangeButtonLabel={t("onboarding.completeLogin")}
          exchangeBusyLabel={t("subscriptionstatus.Completing")}
          disconnecting={subscriptionDisconnecting === "openai-subscription"}
          onStartOauth={() => void handleOpenAIStart()}
          onExchange={() => void handleOpenAIExchange()}
          onResetFlow={() => {
            setOpenaiOAuthStarted(false);
            setOpenaiCallbackUrl("");
            setOpenaiError("");
          }}
          onDisconnect={() =>
            void handleDisconnectSubscription("openai-subscription")
          }
        />
      )}

      {genericStoredProvider ? (
        <div className="rounded-lg border border-border/40 bg-card/40 px-3 py-2 text-xs leading-relaxed">
          <div className="font-semibold">
            {genericStatus?.available === false
              ? t("subscriptionstatus.ProviderUnavailable", {
                  defaultValue: "Provider unavailable",
                })
              : genericStatus?.configured && genericStatus.valid
                ? t("subscriptionstatus.CodingSubscriptionReady", {
                    defaultValue: "Coding subscription ready",
                  })
                : t("subscriptionstatus.CodingSubscriptionSetup", {
                    defaultValue: "Coding subscription setup",
                  })}
          </div>
          <p className="mt-1 text-muted">
            {genericStatus?.availabilityReason ||
              genericStatus?.loginHint ||
              t("subscriptionstatus.CodingSubscriptionSafeSurface", {
                defaultValue:
                  "This provider is limited to its first-party coding surface. Credentials are not copied into general API environment variables.",
              })}
          </p>
          {genericStatus?.allowedClient ? (
            <p className="mt-1 text-muted">
              {t("subscriptionstatus.AllowedClient", {
                defaultValue: `Allowed client: ${genericStatus.allowedClient}`,
                client: genericStatus.allowedClient,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

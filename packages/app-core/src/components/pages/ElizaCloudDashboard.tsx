import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
} from "@elizaos/ui";
import {
  ArrowLeft,
  CreditCard,
  ExternalLink,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type CloudBillingCheckoutResponse,
  type CloudBillingSettings,
  type CloudBillingSummary,
  client,
  isRateLimitedError,
} from "../../api";
import { useApp } from "../../state";
import { openExternalUrl, preOpenWindow } from "../../utils";
import { StripeEmbeddedCheckout } from "../cloud/StripeEmbeddedCheckout";
import {
  autoTopUpFormReducer,
  BILLING_PRESET_AMOUNTS,
  buildAutoTopUpFormState,
  consumeManagedDiscordCallbackUrl,
  consumeManagedGithubCallbackUrl,
  ELIZA_CLOUD_WEB_URL,
  getBillingAutoTopUp,
  getBillingLimits,
  isRecord,
  normalizeBillingSettings,
  normalizeBillingSummary,
  readBoolean,
  readNumber,
  readString,
  resolveCheckoutUrl,
  resolveCloudAccountIdDisplay,
} from "./cloud-dashboard-utils";

export function CloudDashboard() {
  const {
    t,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    elizaCloudAuthRejected,
    elizaCloudTopUpUrl,
    elizaCloudUserId,
    elizaCloudStatusReason,
    cloudDashboardView,
    elizaCloudLoginBusy,
    handleCloudLogin,
    handleCloudDisconnect,
    elizaCloudDisconnecting: cloudDisconnecting,
    setActionNotice,
    setState,
  } = useApp();

  const [refreshing, setRefreshing] = useState(false);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingSummary, setBillingSummary] =
    useState<CloudBillingSummary | null>(null);
  const [billingSettings, setBillingSettings] =
    useState<CloudBillingSettings | null>(null);
  // When non-null, Eliza Cloud is rate-limiting us; render a countdown until
  // the wall-clock passes this timestamp instead of "Too many requests".
  const [rateLimitedUntilMs, setRateLimitedUntilMs] = useState<number | null>(
    null,
  );
  const [, setCountdownTick] = useState(0);
  const fetchInFlightRef = useRef<Promise<void> | null>(null);
  const rateLimitRetryScheduledRef = useRef(false);
  const [billingAmount, setBillingAmount] = useState("25");
  const [autoTopUpForm, dispatchAutoTopUpForm] = useReducer(
    autoTopUpFormReducer,
    buildAutoTopUpFormState(null, null),
  );
  const [billingSettingsBusy, setBillingSettingsBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutSession, setCheckoutSession] =
    useState<CloudBillingCheckoutResponse | null>(null);
  const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false);
  const mountedRef = useRef(true);
  const handledDiscordCallbackRef = useRef(false);
  const handledGithubCallbackRef = useRef(false);
  const autoTopUpEnabled = autoTopUpForm.enabled;
  const autoTopUpAmount = autoTopUpForm.amount;
  const autoTopUpThreshold = autoTopUpForm.threshold;

  const view = cloudDashboardView;
  const goOverview = useCallback(
    () => setState("cloudDashboardView", "overview"),
    [setState],
  );
  const goBilling = useCallback(
    () => setState("cloudDashboardView", "billing"),
    [setState],
  );

  const fetchBillingData = useCallback(async () => {
    if (fetchInFlightRef.current) return fetchInFlightRef.current;
    const run = (async () => {
      setBillingLoading(true);
      setBillingError(null);
      try {
        const [summaryResponse, settingsResponse] = await Promise.all([
          client.getCloudBillingSummary().catch((err) => ({ __error: err })),
          client.getCloudBillingSettings().catch((err) => ({ __error: err })),
        ]);

        if (!mountedRef.current) return;

        // Detect rate-limit independently on each half. We have to handle
        // them separately so that a settings-only rate-limit doesn't discard
        // a successfully-fetched summary (and vice-versa) — for a first-time
        // visitor with no cached state that would mean a blank balance for
        // the full countdown window even though the data was just fetched.
        const summaryRateLimited =
          isRecord(summaryResponse) && "__error" in summaryResponse
            ? isRateLimitedError(summaryResponse.__error)
              ? summaryResponse.__error
              : null
            : null;
        const settingsRateLimited =
          isRecord(settingsResponse) && "__error" in settingsResponse
            ? isRateLimitedError(settingsResponse.__error)
              ? settingsResponse.__error
              : null
            : null;
        const rateLimitedErr = summaryRateLimited ?? settingsRateLimited;
        const rateLimitDeadlineMs = rateLimitedErr
          ? Date.now() +
            (typeof rateLimitedErr.retryAfter === "number" &&
            rateLimitedErr.retryAfter > 0
              ? Math.ceil(rateLimitedErr.retryAfter)
              : 60) *
              1000
          : null;

        if (summaryRateLimited) {
          // Summary itself was throttled — preserve last-known summary AND
          // last-known settings. Showing a countdown is the most we can do.
          setRateLimitedUntilMs(rateLimitDeadlineMs);
          return;
        }

        if (isRecord(summaryResponse) && "__error" in summaryResponse) {
          const err = summaryResponse.__error;
          setRateLimitedUntilMs(null);
          throw err instanceof Error
            ? err
            : new Error(
                t("elizaclouddashboard.BillingSummaryUnavailable", {
                  defaultValue: "Billing summary unavailable.",
                }),
              );
        }

        // Summary succeeded — apply the fresh balance immediately, even if
        // settings is rate-limited or otherwise failed.
        setBillingSummary(normalizeBillingSummary(summaryResponse));

        if (settingsRateLimited) {
          // Settings was throttled but summary was fine. Keep last-known
          // settings (don't null them out) and show the countdown banner.
          setRateLimitedUntilMs(rateLimitDeadlineMs);
          return;
        }

        setRateLimitedUntilMs(null);

        if (isRecord(settingsResponse) && !("__error" in settingsResponse)) {
          setBillingSettings(normalizeBillingSettings(settingsResponse));
        } else {
          setBillingSettings(null);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setBillingSummary(null);
        setBillingSettings(null);
        setBillingError(
          err instanceof Error
            ? err.message
            : t("elizaclouddashboard.FailedToLoadBillingData", {
                defaultValue: "Failed to load billing data.",
              }),
        );
      } finally {
        if (mountedRef.current) setBillingLoading(false);
      }
    })();
    fetchInFlightRef.current = run;
    try {
      await run;
    } finally {
      fetchInFlightRef.current = null;
    }
  }, [t]);

  useEffect(() => {
    dispatchAutoTopUpForm({
      type: "hydrate",
      next: buildAutoTopUpFormState(billingSummary, billingSettings),
    });
  }, [billingSettings, billingSummary]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchBillingData();
    setTimeout(() => setRefreshing(false), 400);
  }, [fetchBillingData]);

  const handleSaveBillingSettings = useCallback(async () => {
    const limits = getBillingLimits(billingSettings);
    const amount = Number(autoTopUpAmount);
    const threshold = Number(autoTopUpThreshold);
    const minAmount = readNumber(limits.minAmount) ?? 1;
    const maxAmount = readNumber(limits.maxAmount) ?? 1000;
    const minThreshold = readNumber(limits.minThreshold) ?? 0;
    const maxThreshold = readNumber(limits.maxThreshold) ?? 1000;
    const hasPaymentMethod =
      readBoolean(getBillingAutoTopUp(billingSettings).hasPaymentMethod) ??
      readBoolean(
        (billingSummary as Record<string, unknown> | null)?.hasPaymentMethod,
      ) ??
      false;

    if (!Number.isFinite(amount) || amount < minAmount || amount > maxAmount) {
      setActionNotice(
        t("elizaclouddashboard.AutoTopUpAmountRange", {
          defaultValue:
            "Auto top-up amount must be between $" +
            "{{min}}" +
            " and $" +
            "{{max}}.",
          min: minAmount,
          max: maxAmount,
        }),
        "error",
        3600,
      );
      return;
    }

    if (
      !Number.isFinite(threshold) ||
      threshold < minThreshold ||
      threshold > maxThreshold
    ) {
      setActionNotice(
        t("elizaclouddashboard.AutoTopUpThresholdRange", {
          defaultValue:
            "Auto top-up threshold must be between $" +
            "{{min}}" +
            " and $" +
            "{{max}}.",
          min: minThreshold,
          max: maxThreshold,
        }),
        "error",
        3600,
      );
      return;
    }

    if (autoTopUpEnabled && !hasPaymentMethod) {
      setActionNotice(
        t("elizaclouddashboard.SavePaymentMethodBeforeAutoTopUp", {
          defaultValue: "Add a card first",
        }),
        "info",
        4200,
      );
      return;
    }

    setBillingSettingsBusy(true);
    try {
      const response = await client.updateCloudBillingSettings({
        autoTopUp: { enabled: autoTopUpEnabled, amount, threshold },
      });
      if (!mountedRef.current) return;
      const normalizedSettings = normalizeBillingSettings(response);
      setBillingSettings(normalizedSettings);
      dispatchAutoTopUpForm({
        type: "hydrate",
        next: buildAutoTopUpFormState(billingSummary, normalizedSettings),
        force: true,
      });
      await fetchBillingData();
      setActionNotice(
        t("elizaclouddashboard.BillingSettingsUpdated", {
          defaultValue: "Billing settings updated.",
        }),
        "success",
        3200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToUpdateBillingSettings", {
              defaultValue: "Failed to update billing settings.",
            }),
        "error",
        4200,
      );
    } finally {
      if (mountedRef.current) setBillingSettingsBusy(false);
    }
  }, [
    autoTopUpAmount,
    autoTopUpEnabled,
    autoTopUpThreshold,
    billingSettings,
    billingSummary,
    fetchBillingData,
    setActionNotice,
    t,
  ]);

  const handleStartCheckout = useCallback(async () => {
    const minimumTopUp =
      readNumber(
        (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
      ) ?? 1;
    const amountUsd = Number(billingAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < minimumTopUp) {
      setActionNotice(
        t("elizaclouddashboard.EnterTopUpAmountMinimum", {
          defaultValue: "Enter a top-up amount of at least $" + "{{amount}}.",
          amount: minimumTopUp,
        }),
        "error",
        3200,
      );
      return;
    }

    setCheckoutBusy(true);
    try {
      const response = await client.createCloudBillingCheckout({
        amountUsd,
        mode: billingSummary?.embeddedCheckoutEnabled ? "embedded" : "hosted",
      });

      const clientSecret = readString(response.clientSecret);
      const publishableKey = readString(response.publishableKey);
      if (clientSecret && publishableKey) {
        setCheckoutSession(response);
        setCheckoutDialogOpen(true);
        return;
      }

      const checkoutUrl = resolveCheckoutUrl(response);
      if (checkoutUrl) {
        await openExternalUrl(checkoutUrl);
        return;
      }

      throw new Error(
        t("elizaclouddashboard.CheckoutSessionMissing", {
          defaultValue:
            "Checkout unavailable. Try again or use the billing portal.",
        }),
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToStartCheckout", {
              defaultValue: "Failed to start checkout.",
            }),
        "error",
        4200,
      );
    } finally {
      setCheckoutBusy(false);
    }
  }, [billingAmount, billingSummary, setActionNotice, t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Tick once per second while rate-limited so the countdown re-renders, then
  // fire one auto-retry when the window expires. We schedule the retry once
  // per rate-limit window (gated by rateLimitRetryScheduledRef) so we never
  // turn this into a tight retry loop against an upstream that's still refusing.
  useEffect(() => {
    if (rateLimitedUntilMs === null) {
      rateLimitRetryScheduledRef.current = false;
      return;
    }
    const interval = window.setInterval(() => {
      if (!mountedRef.current) return;
      const remaining = rateLimitedUntilMs - Date.now();
      if (remaining > 0) {
        setCountdownTick((n) => n + 1);
        return;
      }
      window.clearInterval(interval);
      if (rateLimitRetryScheduledRef.current) return;
      rateLimitRetryScheduledRef.current = true;
      setRateLimitedUntilMs(null);
      void fetchBillingData();
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [rateLimitedUntilMs, fetchBillingData]);

  // Refetch billing only when the cloud-connected flag flips. We deliberately
  // exclude `fetchBillingData` from the dep array: its identity tracks `t`
  // (i18n) and changes on every render, which would re-fire this effect every
  // render and hammer `/api/cloud/billing/{summary,settings}` until Eliza
  // Cloud rate-limits the keypair with 429s. The "fire once on connect" is
  // the only intended behaviour; manual refresh + post-mutation refresh both
  // call `fetchBillingData` directly elsewhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (elizaCloudConnected) {
      void fetchBillingData();
    }
  }, [elizaCloudConnected]);

  // Drop cached billing on disconnect so we never show a stale balance.
  useEffect(() => {
    if (elizaCloudConnected) return;
    setBillingSummary(null);
    setBillingSettings(null);
    setBillingError(null);
    setCheckoutSession(null);
    setCheckoutDialogOpen(false);
    dispatchAutoTopUpForm({
      type: "hydrate",
      next: buildAutoTopUpFormState(null, null),
      force: true,
    });
  }, [elizaCloudConnected]);

  // Managed Discord / GitHub OAuth callbacks: server-side already linked the
  // connection — we just surface a toast and strip query params from the URL.
  useEffect(() => {
    if (handledDiscordCallbackRef.current || typeof window === "undefined") {
      return;
    }
    const { callback, cleanedUrl } = consumeManagedDiscordCallbackUrl(
      window.location.href,
    );
    if (!callback) return;
    handledDiscordCallbackRef.current = true;
    if (cleanedUrl && cleanedUrl !== window.location.href) {
      window.history.replaceState({}, document.title, cleanedUrl);
    }
    if (callback.status === "connected") {
      setActionNotice(
        callback.guildName
          ? t("elizaclouddashboard.ManagedDiscordConnectedNotice", {
              defaultValue: callback.restarted
                ? "Managed Discord connected to {{guild}}. The agent restarted and is ready."
                : "Managed Discord connected to {{guild}}.",
              guild: callback.guildName,
            })
          : t("elizaclouddashboard.ManagedDiscordConnectedNoticeFallback", {
              defaultValue: callback.restarted
                ? "Managed Discord connected. The agent restarted and is ready."
                : "Managed Discord connected.",
            }),
        "success",
        5200,
      );
      return;
    }
    setActionNotice(
      callback.message ||
        t("elizaclouddashboard.ManagedDiscordConnectFailed", {
          defaultValue: "Managed Discord setup did not complete.",
        }),
      "error",
      5200,
    );
  }, [setActionNotice, t]);

  useEffect(() => {
    if (handledGithubCallbackRef.current || typeof window === "undefined") {
      return;
    }
    const { callback, cleanedUrl } = consumeManagedGithubCallbackUrl(
      window.location.href,
    );
    if (!callback) return;
    handledGithubCallbackRef.current = true;
    if (cleanedUrl && cleanedUrl !== window.location.href) {
      window.history.replaceState({}, document.title, cleanedUrl);
    }
    if (callback.status === "connected") {
      setActionNotice(
        t("elizaclouddashboard.ManagedGithubConnectedNotice", {
          defaultValue: "GitHub account connected to this agent.",
        }),
        "success",
        5200,
      );
      return;
    }
    setActionNotice(
      callback.message ||
        t("lifeopspage.githubSetupIncomplete", {
          defaultValue: "GitHub setup did not complete.",
        }),
      "error",
      5200,
    );
  }, [setActionNotice, t]);

  const summaryCritical =
    elizaCloudAuthRejected ||
    (billingSummary?.critical ?? elizaCloudCreditsCritical ?? false);
  const summaryLow = billingSummary?.low ?? elizaCloudCreditsLow ?? false;
  const creditStatusColor = summaryCritical
    ? "text-danger"
    : summaryLow
      ? "text-warn"
      : "text-ok";
  const cloudBalanceNumber =
    typeof elizaCloudCredits === "number"
      ? elizaCloudCredits
      : typeof billingSummary?.balance === "number"
        ? billingSummary.balance
        : null;
  const cloudCurrency = billingSummary?.currency ?? "USD";
  const fallbackBillingUrl =
    billingSummary?.topUpUrl ?? elizaCloudTopUpUrl ?? null;
  const minimumTopUp =
    readNumber(
      (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
    ) ?? 1;
  const billingAutoTopUp = getBillingAutoTopUp(billingSettings);
  const billingLimits = getBillingLimits(billingSettings);
  const autoTopUpHasPaymentMethod =
    readBoolean(billingAutoTopUp.hasPaymentMethod) ??
    readBoolean(
      (billingSummary as Record<string, unknown> | null)?.hasPaymentMethod,
    ) ??
    false;
  const autoTopUpMinAmount =
    readNumber(billingLimits.minAmount) ?? minimumTopUp;
  const autoTopUpMaxAmount = readNumber(billingLimits.maxAmount) ?? 1000;
  const autoTopUpMinThreshold = readNumber(billingLimits.minThreshold) ?? 0;
  const autoTopUpMaxThreshold = readNumber(billingLimits.maxThreshold) ?? 1000;
  const creditStatusTone = elizaCloudAuthRejected
    ? t("notice.elizaCloudAuthRejected")
    : summaryCritical
      ? t("elizaclouddashboard.CreditsCritical")
      : summaryLow
        ? t("elizaclouddashboard.CreditsLow")
        : t("elizaclouddashboard.CreditsHealthy");
  const statusChipClass = summaryCritical
    ? "border-danger/30 bg-danger/10 text-danger"
    : summaryLow
      ? "border-warn/30 bg-warn/10 text-warn"
      : "border-ok/30 bg-ok/10 text-ok";
  const accountIdDisplay = resolveCloudAccountIdDisplay(
    elizaCloudUserId,
    elizaCloudStatusReason,
    t,
  );
  const formattedBalance =
    cloudBalanceNumber !== null ? cloudBalanceNumber.toFixed(2) : null;
  const currencyPrefix = cloudCurrency === "USD" ? "$" : `${cloudCurrency} `;
  const rateLimitRemainingSec =
    rateLimitedUntilMs !== null
      ? Math.max(0, Math.ceil((rateLimitedUntilMs - Date.now()) / 1000))
      : 0;
  const isRateLimited = rateLimitRemainingSec > 0;
  const rateLimitMessage = isRateLimited
    ? t("elizaclouddashboard.RateLimitedRetryIn", {
        defaultValue:
          "Eliza Cloud is rate-limiting this account; retrying in {{seconds}}s.",
        seconds: rateLimitRemainingSec,
      })
    : null;

  if (!elizaCloudConnected) {
    return (
      <div className="mx-auto flex max-w-sm flex-wrap items-center justify-center gap-2 px-3 py-5 text-center">
        <Button
          variant="default"
          size="sm"
          className="h-8 rounded-lg px-3 text-xs font-semibold"
          onClick={() => void handleCloudLogin(preOpenWindow())}
          disabled={elizaCloudLoginBusy}
        >
          {elizaCloudLoginBusy ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Zap className="mr-2 h-4 w-4" />
          )}
          {elizaCloudLoginBusy
            ? t("game.connecting")
            : t("elizaclouddashboard.ConnectElizaCloud")}
        </Button>
        <Button
          variant="link"
          className="h-8 px-2 text-xs text-muted"
          onClick={() => void openExternalUrl(ELIZA_CLOUD_WEB_URL)}
        >
          {t("elizaclouddashboard.LearnMore")}
        </Button>
      </div>
    );
  }

  const overviewContent = (
    <div className="px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CreditCard className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span
            className={`text-base font-semibold tracking-tight tabular-nums ${creditStatusColor}`}
          >
            {currencyPrefix}
            {formattedBalance ?? (
              <span className="text-muted">{billingLoading ? "…" : "—"}</span>
            )}
          </span>
          {billingLoading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
          )}
        </div>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider ${statusChipClass}`}
        >
          {creditStatusTone}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="default"
            size="sm"
            className="h-8 rounded-lg px-2.5 text-xs font-semibold"
            onClick={goBilling}
          >
            <CreditCard className="mr-1.5 h-3.5 w-3.5" />
            {t("elizaclouddashboard.TopUpCredits", {
              defaultValue: "Top up credits",
            })}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-lg"
            onClick={handleRefresh}
            disabled={refreshing || billingLoading || isRateLimited}
            aria-label={t("common.refresh")}
            title={
              isRateLimited
                ? (rateLimitMessage ?? t("common.refresh"))
                : t("common.refresh")
            }
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-danger/30 px-2.5 text-danger text-xs hover:bg-danger/10"
            onClick={() => void handleCloudDisconnect()}
            disabled={cloudDisconnecting}
          >
            {cloudDisconnecting
              ? t("providerswitcher.disconnecting")
              : t("common.disconnect")}
          </Button>
        </div>
      </div>

      {elizaCloudAuthRejected && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {t("notice.elizaCloudAuthRejected")}
        </div>
      )}

      {rateLimitMessage && (
        <div
          role="status"
          className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn"
        >
          {rateLimitMessage}
        </div>
      )}

      {!rateLimitMessage && billingError && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {billingError}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <span
          className="inline-flex max-w-full items-center rounded-md border border-border/50 bg-bg/55 px-2 py-1 text-muted"
          title={t("common.account", { defaultValue: "Account" })}
        >
          {accountIdDisplay.mono ? (
            <code className="truncate font-mono text-txt">
              {accountIdDisplay.text}
            </code>
          ) : (
            <span className="truncate text-txt">{accountIdDisplay.text}</span>
          )}
        </span>
        <span
          className="inline-flex items-center rounded-md border border-border/50 bg-bg/55 px-2 py-1 text-muted"
          title={t("elizaclouddashboard.AutoTopUp", {
            defaultValue: "Auto top-up",
          })}
        >
          {billingAutoTopUp.enabled
            ? t("elizaclouddashboard.OnAmount", {
                defaultValue:
                  "Auto $" + "{{amount}}" + " below $" + "{{threshold}}",
                amount: Number(autoTopUpForm.amount).toFixed(0),
                threshold: Number(autoTopUpForm.threshold).toFixed(0),
              })
            : t("elizaclouddashboard.AutoTopUpOff", {
                defaultValue: "Auto top-up off",
              })}
        </span>
      </div>
    </div>
  );

  const billingContent = (
    <div className="px-5 py-6 sm:px-6">
      <div className="mb-5 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-lg px-2 text-muted hover:text-txt"
          onClick={goOverview}
          aria-label={t("common.back", { defaultValue: "Back" })}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-sm font-semibold text-txt-strong">
          {t("elizaclouddashboard.TopUpCredits", {
            defaultValue: "Top up credits",
          })}
        </h3>
        <span className="ml-auto text-xs text-muted tabular-nums">
          {currencyPrefix}
          {formattedBalance ?? (billingLoading ? "…" : "—")}
        </span>
      </div>

      {rateLimitMessage && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn"
        >
          {rateLimitMessage}
        </div>
      )}

      {!rateLimitMessage && billingError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {billingError}
        </div>
      )}

      {/* Pay with card */}
      <div className="mb-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
          {t("elizaclouddashboard.PayWithCard")}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {BILLING_PRESET_AMOUNTS.map((amount) => {
            const active = billingAmount === String(amount);
            return (
              <Button
                key={amount}
                variant={active ? "default" : "outline"}
                size="sm"
                className="h-8 rounded-lg px-3 text-xs font-medium"
                onClick={() => setBillingAmount(String(amount))}
              >
                ${amount}
              </Button>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Input
            id="cloud-billing-amount"
            type="number"
            min={String(minimumTopUp)}
            step="1"
            value={billingAmount}
            onChange={(e) => setBillingAmount(e.target.value)}
            className="h-9 flex-1 rounded-lg bg-bg text-sm"
            placeholder={t("elizaclouddashboard.MinAmountPlaceholder", {
              defaultValue: "Min $" + "{{amount}}",
              amount: minimumTopUp.toFixed(2),
            })}
          />
          <Button
            variant="default"
            size="sm"
            className="h-9 rounded-lg px-4 font-semibold"
            disabled={checkoutBusy || billingLoading}
            onClick={() => void handleStartCheckout()}
          >
            {checkoutBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("elizaclouddashboard.Pay", { defaultValue: "Pay" })
            )}
          </Button>
        </div>
      </div>

      {/* Auto top-up */}
      <div className="mb-6 border-t border-border/40 pt-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">
              {t("elizaclouddashboard.AutoTopUp")}
            </div>
            <p className="mt-0.5 text-xs-tight text-muted">
              {autoTopUpHasPaymentMethod
                ? t("elizaclouddashboard.AutoTopUpPaymentReady", {
                    defaultValue: "Card saved",
                  })
                : t("elizaclouddashboard.AutoTopUpNeedsPaymentMethod", {
                    defaultValue: "Add a card first",
                  })}
            </p>
          </div>
          <Switch
            checked={autoTopUpEnabled}
            onCheckedChange={(v: boolean) =>
              dispatchAutoTopUpForm({ type: "setEnabled", value: v })
            }
            aria-label={t("elizaclouddashboard.ToggleAutoTopUp")}
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <label
              htmlFor="cloud-auto-topup-threshold"
              className="text-xs-tight text-muted"
            >
              {t("elizaclouddashboard.RefillWhenBelow", {
                defaultValue: "Refill when below",
              })}
            </label>
            <Input
              id="cloud-auto-topup-threshold"
              type="number"
              min={String(autoTopUpMinThreshold)}
              max={String(autoTopUpMaxThreshold)}
              step="1"
              value={autoTopUpThreshold}
              onChange={(e) =>
                dispatchAutoTopUpForm({
                  type: "setThreshold",
                  value: e.target.value,
                })
              }
              className="h-9 rounded-lg bg-bg"
            />
          </div>
          <div className="flex-1 space-y-1">
            <label
              htmlFor="cloud-auto-topup-amount"
              className="text-xs-tight text-muted"
            >
              {t("elizaclouddashboard.TopUpAmount", {
                defaultValue: "Top-up amount",
              })}
            </label>
            <Input
              id="cloud-auto-topup-amount"
              type="number"
              min={String(autoTopUpMinAmount)}
              max={String(autoTopUpMaxAmount)}
              step="1"
              value={autoTopUpAmount}
              onChange={(e) =>
                dispatchAutoTopUpForm({
                  type: "setAmount",
                  value: e.target.value,
                })
              }
              className="h-9 rounded-lg bg-bg"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-lg px-4 sm:self-end"
            disabled={
              billingSettingsBusy || billingLoading || !autoTopUpForm.dirty
            }
            onClick={() => void handleSaveBillingSettings()}
          >
            {billingSettingsBusy && (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            )}
            {t("common.save")}
          </Button>
        </div>
      </div>

      {fallbackBillingUrl && (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs text-muted hover:text-txt"
          onClick={() => void openExternalUrl(fallbackBillingUrl)}
        >
          {t("elizaclouddashboard.OpenBrowserBilling")}
          <ExternalLink className="ml-1 h-3 w-3" />
        </Button>
      )}
    </div>
  );

  return (
    <>
      {view === "billing" ? billingContent : overviewContent}

      <Dialog
        open={checkoutDialogOpen}
        onOpenChange={(open: boolean) => {
          setCheckoutDialogOpen(open);
          if (!open) void fetchBillingData();
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("elizaclouddashboard.PayWithCard")}</DialogTitle>
          </DialogHeader>
          {checkoutSession?.clientSecret && checkoutSession.publishableKey ? (
            <StripeEmbeddedCheckout
              publishableKey={checkoutSession.publishableKey}
              clientSecret={checkoutSession.clientSecret}
            />
          ) : (
            <div className="rounded-2xl border border-border/40 bg-bg/25 px-4 py-5 text-sm text-muted">
              {t("elizaclouddashboard.CheckoutProviderNote")}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

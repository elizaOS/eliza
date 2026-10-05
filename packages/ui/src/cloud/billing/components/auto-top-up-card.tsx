/**
 * Auto Top-Up — settings UI for the Stripe-funded refill path.
 *
 * When the org's credit balance dips below `threshold`, the cron charges the
 * saved card for `amount` and credits the org. Independent of the earnings
 * auto-fund path — both can be enabled together. The earnings cron runs first so
 * card charges only happen if earnings can't cover.
 *
 * Enable is a SettingsSwitchRow. Amount and threshold are SettingsInputRow
 * number fields. Save and canonical Card chrome stay as the multi-field editor.
 * Reads/writes /api/v1/billing/settings.
 *
 * Charge disclosure (#23020): when an affiliate surcharge applies, the card
 * shows the credited base, affiliate markup, platform fee and total card
 * charge as separate lines before the customer saves. The amounts come from
 * the server (`autoTopUp.chargePreview`, re-quoted with `?previewAmount=` as
 * the amount is edited); the client never computes money.
 */

"use client";

import {
  AlertCircle,
  CreditCard,
  DollarSign,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../../bridge/toast";
import {
  SettingsInputRow,
  SettingsSwitchRow,
} from "../../../components/settings/settings-agent-rows";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { CornerBrackets } from "../../../components/ui/corner-brackets";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

export interface AutoTopUpChargePreview {
  attribution: "none" | "affiliate" | "unavailable";
  breakdown: {
    creditedBaseUsd: string;
    affiliateMarkupUsd: string;
    platformFeeUsd: string;
    totalChargeUsd: string;
    surchargeApplies: boolean;
  };
}

interface AutoTopUpSettings {
  enabled: boolean;
  amount: number;
  threshold: number;
  hasPaymentMethod: boolean;
  chargePreview: AutoTopUpChargePreview | null;
}

interface Limits {
  minAmount: number;
  maxAmount: number;
  minThreshold: number;
  maxThreshold: number;
}

interface BillingSettingsResponse {
  settings: {
    autoTopUp: AutoTopUpSettings;
    limits: Limits;
  };
}

const ENDPOINT = "/api/v1/billing/settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Billing settings response omitted ${field}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Billing settings response omitted ${field}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Billing settings response omitted ${field}`);
  }
  return value;
}

const USD_AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/;

function requireUsd(value: unknown, field: string): string {
  if (typeof value !== "string" || !USD_AMOUNT.test(value)) {
    throw new TypeError(`Billing settings response omitted ${field}`);
  }
  return value;
}

function parseChargePreview(value: unknown): AutoTopUpChargePreview | null {
  if (value === null || value === undefined) return null;
  const preview = requireRecord(value, "settings.autoTopUp.chargePreview");
  const attribution = preview.attribution;
  if (
    attribution !== "none" &&
    attribution !== "affiliate" &&
    attribution !== "unavailable"
  ) {
    throw new TypeError(
      "Billing settings response omitted settings.autoTopUp.chargePreview.attribution",
    );
  }
  const breakdown = requireRecord(
    preview.breakdown,
    "settings.autoTopUp.chargePreview.breakdown",
  );
  return {
    attribution,
    breakdown: {
      creditedBaseUsd: requireUsd(breakdown.creditedBaseUsd, "creditedBaseUsd"),
      affiliateMarkupUsd: requireUsd(
        breakdown.affiliateMarkupUsd,
        "affiliateMarkupUsd",
      ),
      platformFeeUsd: requireUsd(breakdown.platformFeeUsd, "platformFeeUsd"),
      totalChargeUsd: requireUsd(breakdown.totalChargeUsd, "totalChargeUsd"),
      surchargeApplies: requireBoolean(
        breakdown.surchargeApplies,
        "surchargeApplies",
      ),
    },
  };
}

function parseAutoTopUpSettings(value: unknown): AutoTopUpSettings {
  const settings = requireRecord(value, "settings.autoTopUp");
  return {
    enabled: requireBoolean(settings.enabled, "settings.autoTopUp.enabled"),
    amount: requireFiniteNumber(settings.amount, "settings.autoTopUp.amount"),
    threshold: requireFiniteNumber(
      settings.threshold,
      "settings.autoTopUp.threshold",
    ),
    hasPaymentMethod: requireBoolean(
      settings.hasPaymentMethod,
      "settings.autoTopUp.hasPaymentMethod",
    ),
    chargePreview: parseChargePreview(settings.chargePreview),
  };
}

function parseBillingSettingsResponse(value: unknown): BillingSettingsResponse {
  const response = requireRecord(value, "response");
  const settings = requireRecord(response.settings, "settings");
  const limitsRecord = requireRecord(settings.limits, "settings.limits");
  const limits = {
    minAmount: requireFiniteNumber(
      limitsRecord.minAmount,
      "settings.limits.minAmount",
    ),
    maxAmount: requireFiniteNumber(
      limitsRecord.maxAmount,
      "settings.limits.maxAmount",
    ),
    minThreshold: requireFiniteNumber(
      limitsRecord.minThreshold,
      "settings.limits.minThreshold",
    ),
    maxThreshold: requireFiniteNumber(
      limitsRecord.maxThreshold,
      "settings.limits.maxThreshold",
    ),
  };
  if (
    limits.minAmount > limits.maxAmount ||
    limits.minThreshold > limits.maxThreshold
  ) {
    throw new TypeError("Billing settings response contains inverted limits");
  }
  return {
    settings: {
      autoTopUp: parseAutoTopUpSettings(settings.autoTopUp),
      limits,
    },
  };
}

function parseAutoTopUpSaveResponse(value: unknown): AutoTopUpSettings {
  const response = requireRecord(value, "response");
  const settings = requireRecord(response.settings, "settings");
  return parseAutoTopUpSettings(settings.autoTopUp);
}

function inputValue(value: number): string {
  return value === 0 ? "" : String(value);
}

/** Separate lines for the credited base and any affiliate surcharge. */
export function AutoTopUpChargeBreakdown({
  preview,
}: {
  preview: AutoTopUpChargePreview;
}) {
  const t = useCloudT();
  const { breakdown } = preview;
  const rows: Array<{ key: string; label: string; value: string }> = [
    {
      key: "base",
      label: t("cloud.autoTopUp.breakdown.creditedBase", {
        defaultValue: "Credits added",
      }),
      value: breakdown.creditedBaseUsd,
    },
  ];
  if (breakdown.surchargeApplies) {
    rows.push(
      {
        key: "affiliate",
        label: t("cloud.autoTopUp.breakdown.affiliateMarkup", {
          defaultValue: "Affiliate markup",
        }),
        value: breakdown.affiliateMarkupUsd,
      },
      {
        key: "platform",
        label: t("cloud.autoTopUp.breakdown.platformFee", {
          defaultValue: "Platform fee",
        }),
        value: breakdown.platformFeeUsd,
      },
    );
  }
  return (
    <div
      className="space-y-2 rounded-sm border border-border p-3"
      data-testid="cloud-billing-auto-top-up-breakdown"
    >
      <p className="text-xs font-mono uppercase text-muted">
        {t("cloud.autoTopUp.breakdown.title", {
          defaultValue: "Each automatic top-up",
        })}
      </p>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-4 text-xs font-mono"
          >
            <dt className="text-muted">{row.label}</dt>
            <dd className="tabular-nums text-txt">{`$${row.value}`}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 border-t border-border pt-1 text-xs font-mono">
          <dt className="text-txt">
            {t("cloud.autoTopUp.breakdown.totalCharge", {
              defaultValue: "Total card charge",
            })}
          </dt>
          <dd className="tabular-nums text-txt-strong">
            {`$${breakdown.totalChargeUsd}`}
          </dd>
        </div>
      </dl>
      {breakdown.surchargeApplies ? (
        <p className="text-pretty text-xs font-mono text-muted">
          {t("cloud.autoTopUp.breakdown.affiliateNote", {
            defaultValue:
              "Your account was referred by an affiliate, so each top-up includes the affiliate's markup and a platform fee on top of the credits added.",
          })}
        </p>
      ) : null}
      {preview.attribution === "unavailable" ? (
        <p className="text-pretty text-xs font-mono text-muted">
          {t("cloud.autoTopUp.breakdown.attributionUnavailable", {
            defaultValue:
              "Referral details are temporarily unavailable. If they are still unavailable when a top-up runs, no affiliate surcharge is charged. Your receipt shows the exact amount.",
          })}
        </p>
      ) : null}
    </div>
  );
}

export function AutoTopUpCard() {
  const t = useCloudT();
  const [settings, setSettings] = useState<AutoTopUpSettings | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState("");
  const [chargePreview, setChargePreview] =
    useState<AutoTopUpChargePreview | null>(null);
  const [threshold, setThreshold] = useState("");
  const mountedRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;

    loadInFlightRef.current = true;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const data = parseBillingSettingsResponse(await api<unknown>(ENDPOINT));
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      setSettings(data.settings.autoTopUp);
      setChargePreview(data.settings.autoTopUp.chargePreview);
      setLimits(data.settings.limits);
      setEnabled(data.settings.autoTopUp.enabled);
      setAmount(inputValue(data.settings.autoTopUp.amount));
      setThreshold(inputValue(data.settings.autoTopUp.threshold));
      setLoadFailed(false);
    } catch {
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }
      // error-policy:J4 the settings UI keeps transport and malformed payload failures visibly unavailable and retryable.
      setSettings(null);
      setLimits(null);
      setLoadFailed(true);
    } finally {
      if (generation === loadGenerationRef.current) {
        loadInFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      loadInFlightRef.current = false;
      saveInFlightRef.current = false;
    };
  }, [load]);

  const parsedAmount = parseFloat(amount);
  const parsedThreshold = parseFloat(threshold);

  const currentChargePreview =
    chargePreview &&
    Number(chargePreview.breakdown.creditedBaseUsd) === parsedAmount
      ? chargePreview
      : null;

  // Re-quote the server-computed charge lines while the amount is edited so
  // the surcharge is disclosed before the customer saves (#23020).
  useEffect(() => {
    if (!settings || !limits) return;
    if (
      !Number.isFinite(parsedAmount) ||
      parsedAmount < limits.minAmount ||
      parsedAmount > limits.maxAmount
    ) {
      setChargePreview(null);
      return;
    }
    if (parsedAmount === settings.amount) {
      setChargePreview(settings.chargePreview);
      return;
    }
    setChargePreview(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      void api<unknown>(
        `${ENDPOINT}?previewAmount=${encodeURIComponent(String(parsedAmount))}`,
      )
        .then((response) => {
          if (cancelled || !mountedRef.current) return;
          setChargePreview(
            parseBillingSettingsResponse(response).settings.autoTopUp
              .chargePreview,
          );
        })
        .catch(() => {
          // error-policy:J4 a failed re-quote hides the stale lines instead of
          // showing amounts for a different top-up size.
          if (!cancelled && mountedRef.current) setChargePreview(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [limits, parsedAmount, settings]);

  const amountError = useMemo(() => {
    if (!limits || !enabled) return null;
    if (!Number.isFinite(parsedAmount) || parsedAmount < limits.minAmount)
      return t("cloud.autoTopUp.amountMin", {
        min: limits.minAmount,
        defaultValue: "Enter at least {{min}} USD",
      });
    if (parsedAmount > limits.maxAmount)
      return t("cloud.autoTopUp.amountMax", {
        max: limits.maxAmount,
        defaultValue: "Enter at most {{max}} USD",
      });
    return null;
  }, [enabled, limits, parsedAmount, t]);

  const thresholdError = useMemo(() => {
    if (!limits || !enabled) return null;
    if (
      !Number.isFinite(parsedThreshold) ||
      parsedThreshold < limits.minThreshold
    )
      return t("cloud.autoTopUp.thresholdMin", {
        min: limits.minThreshold,
        defaultValue: "Enter at least {{min}} USD",
      });
    if (parsedThreshold > limits.maxThreshold)
      return t("cloud.autoTopUp.thresholdMax", {
        max: limits.maxThreshold,
        defaultValue: "Enter at most {{max}} USD",
      });
    return null;
  }, [enabled, limits, parsedThreshold, t]);

  const handleSave = async () => {
    if (
      saveInFlightRef.current ||
      loading ||
      loadFailed ||
      !settings ||
      !limits ||
      !settings.hasPaymentMethod
    ) {
      return;
    }
    if (amountError) {
      document.getElementById("cloud-billing-auto-top-up-amount")?.focus();
      return;
    }
    if (thresholdError) {
      document.getElementById("cloud-billing-auto-top-up-threshold")?.focus();
      return;
    }

    if (enabled && !amountError && !currentChargePreview) return;

    saveInFlightRef.current = true;
    const generation = ++saveGenerationRef.current;
    setSaving(true);
    try {
      const saved = parseAutoTopUpSaveResponse(
        await api<unknown>(ENDPOINT, {
          method: "PUT",
          json: {
            autoTopUp: {
              enabled,
              amount: parsedAmount || undefined,
              threshold: Number.isFinite(parsedThreshold)
                ? parsedThreshold
                : undefined,
            },
          },
        }),
      );
      if (!mountedRef.current || generation !== saveGenerationRef.current) {
        return;
      }

      setSettings(saved);
      setChargePreview(saved.chargePreview);
      setEnabled(saved.enabled);
      setAmount(inputValue(saved.amount));
      setThreshold(inputValue(saved.threshold));
      toast.success(
        t("cloud.autoTopUp.saved", {
          defaultValue: "Auto top-up settings saved",
        }),
      );
    } catch (error) {
      if (!mountedRef.current || generation !== saveGenerationRef.current) {
        return;
      }
      // error-policy:J4 the settings UI preserves the retryable draft and reports save failure without claiming success.
      toast.error(
        error instanceof ApiError
          ? error.message
          : t("cloud.autoTopUp.saveFailed", {
              defaultValue: "Failed to save settings",
            }),
      );
    } finally {
      if (mountedRef.current && generation === saveGenerationRef.current) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  };

  const loadingLabel = t("cloud.autoTopUp.loading", {
    defaultValue: "Loading auto top-up settings",
  });
  const saveLabel = t("cloud.autoTopUp.saveAction", {
    defaultValue: "Save auto top-up",
  });

  if (loadFailed) {
    const errorTitle = t("cloud.billing.loadError", {
      defaultValue: "Couldn't load auto top-up settings",
    });
    const errorDescription = t("cloud.apiKeys.tryAgain", {
      defaultValue:
        "Your current settings are unavailable. Check your connection and retry.",
    });
    const retryLabel = t("common.retry", {
      defaultValue: "Retry",
    });

    return (
      <Card variant="brand" className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <Card
          variant="dangerNotice"
          role="alert"
          aria-labelledby="cloud-auto-top-up-load-error-title"
          aria-describedby="cloud-auto-top-up-load-error-description"
          className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertCircle
              className="mt-0.5 size-5 shrink-0 text-danger"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <h3
                id="cloud-auto-top-up-load-error-title"
                className="text-sm font-mono text-txt"
              >
                {errorTitle}
              </h3>
              <p
                id="cloud-auto-top-up-load-error-description"
                className="text-pretty text-xs font-mono text-muted"
              >
                {errorDescription}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            aria-busy={loading}
            onClick={() => void load()}
          >
            {loading ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            {retryLabel}
          </Button>
        </Card>
      </Card>
    );
  }

  if (loading || !settings || !limits) {
    return (
      <Card variant="brand" className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div
          className="flex items-center justify-center py-12"
          role="status"
          aria-busy="true"
          aria-label={loadingLabel}
        >
          <Loader2
            className="size-5 animate-spin text-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="sr-only">{loadingLabel}</span>
        </div>
      </Card>
    );
  }

  const noPaymentMethod = !settings.hasPaymentMethod;

  return (
    <Card variant="brand" className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="mutedDot" aria-hidden="true" />
            <h3 className="text-base font-mono text-txt uppercase">
              {t("cloud.autoTopUp.title", {
                defaultValue: "Auto top-up (card)",
              })}
            </h3>
          </div>
          <p className="text-pretty text-xs font-mono text-muted">
            {t("cloud.autoTopUp.description", {
              defaultValue:
                "Automatically charge your saved card when credits dip below the threshold.",
            })}
          </p>
        </div>

        <SettingsSwitchRow
          agentId="cloud-billing-auto-top-up"
          group="cloud-billing"
          icon={CreditCard}
          label={t("cloud.autoTopUp.enableLabel", {
            defaultValue: "Enable card auto top-up",
          })}
          description={t("cloud.autoTopUp.enableDescription", {
            defaultValue:
              "When on, your saved card is charged automatically when credits dip below the threshold. When off, the card is not charged automatically.",
          })}
          checked={enabled}
          disabled={saving || !!noPaymentMethod}
          onCheckedChange={setEnabled}
          testId="cloud-billing-auto-top-up"
        />

        {noPaymentMethod && (
          <Alert
            variant="dashboardWarning"
            role="status"
            aria-labelledby="cloud-billing-auto-top-up-payment-warning"
            className="flex items-start gap-2"
          >
            <Info
              className="mt-0.5 size-4 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            <p
              id="cloud-billing-auto-top-up-payment-warning"
              className="text-pretty text-xs font-mono text-status-warning"
            >
              {t("cloud.autoTopUp.noPaymentMethod", {
                defaultValue:
                  "No saved payment method. Add a card on the billing page first to enable auto top-up.",
              })}
            </p>
          </Alert>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SettingsInputRow
            agentId="cloud-billing-auto-top-up-amount"
            group="cloud-billing"
            icon={DollarSign}
            type="number"
            inputMode="decimal"
            label={t("cloud.autoTopUp.amountLabel", {
              defaultValue: "Top-up amount",
            })}
            description={t("cloud.autoTopUp.amountDescription", {
              defaultValue: "Credits added each cycle. Fees are shown below.",
            })}
            value={amount}
            onValueChange={setAmount}
            disabled={saving || !enabled || !!noPaymentMethod}
            error={amountError ?? undefined}
            placeholder="0.00"
            inputClassName="text-base tabular-nums sm:text-sm"
            testId="cloud-billing-auto-top-up-amount"
          />
          <SettingsInputRow
            agentId="cloud-billing-auto-top-up-threshold"
            group="cloud-billing"
            icon={DollarSign}
            type="number"
            inputMode="decimal"
            label={t("cloud.autoTopUp.thresholdLabel", {
              defaultValue: "Trigger threshold",
            })}
            description={t("cloud.autoTopUp.thresholdDescription", {
              defaultValue:
                "Top-up starts when the credit balance falls below this USD amount.",
            })}
            value={threshold}
            onValueChange={setThreshold}
            disabled={saving || !enabled || !!noPaymentMethod}
            error={thresholdError ?? undefined}
            placeholder="0.00"
            inputClassName="text-base tabular-nums sm:text-sm"
            testId="cloud-billing-auto-top-up-threshold"
          />
        </div>

        {enabled && !amountError ? (
          currentChargePreview ? (
            <AutoTopUpChargeBreakdown preview={currentChargePreview} />
          ) : (
            <p role="status" className="text-xs text-muted">
              {t("cloud.autoTopUp.previewPending", {
                defaultValue:
                  "A current charge preview is required before saving. If it does not load, change the amount to retry.",
              })}
            </p>
          )
        ) : null}

        <Card asChild variant="billingTopDivider">
          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              onClick={handleSave}
              disabled={
                saving ||
                !!noPaymentMethod ||
                (enabled && !amountError && !currentChargePreview)
              }
              aria-busy={saving}
            >
              {saving ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <CreditCard className="size-4" aria-hidden="true" />
              )}
              {saveLabel}
            </Button>
          </div>
        </Card>
      </div>
    </Card>
  );
}

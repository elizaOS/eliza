/**
 * Auto Top-Up — settings UI for the Stripe-funded refill path.
 *
 * When the org's credit balance dips below `threshold`, the cron charges the
 * saved card for `amount` and credits the org. Independent of the earnings
 * auto-fund path — both can be enabled together. The earnings cron runs first so
 * card charges only happen if earnings can't cover.
 *
 * Reads/writes /api/v1/billing/settings.
 */

"use client";

import {
  BrandCard,
  Button,
  CornerBrackets,
  Label,
  Switch,
} from "@elizaos/ui/cloud-ui";
import { CreditCard, Info, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { NumericField } from "./numeric-field";

interface AutoTopUpSettings {
  enabled: boolean;
  amount: number;
  threshold: number;
  hasPaymentMethod: boolean;
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

export function AutoTopUpCard() {
  const t = useCloudT();
  const [settings, setSettings] = useState<AutoTopUpSettings | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState("");
  const [threshold, setThreshold] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<BillingSettingsResponse>(ENDPOINT);
      setSettings(data.settings.autoTopUp);
      setLimits(data.settings.limits);
      setEnabled(data.settings.autoTopUp.enabled);
      setAmount(String(data.settings.autoTopUp.amount || ""));
      setThreshold(String(data.settings.autoTopUp.threshold || ""));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parsedAmount = parseFloat(amount);
  const parsedThreshold = parseFloat(threshold);

  const validationError = useMemo(() => {
    if (!limits || !enabled) return null;
    if (!Number.isFinite(parsedAmount) || parsedAmount < limits.minAmount)
      return t("cloud.autoTopUp.amountMin", {
        min: limits.minAmount,
        defaultValue: "Amount must be at least $" + "{{min}}",
      });
    if (parsedAmount > limits.maxAmount)
      return t("cloud.autoTopUp.amountMax", {
        max: limits.maxAmount,
        defaultValue: "Amount can't exceed $" + "{{max}}",
      });
    if (
      !Number.isFinite(parsedThreshold) ||
      parsedThreshold < limits.minThreshold
    )
      return t("cloud.autoTopUp.thresholdMin", {
        min: limits.minThreshold,
        defaultValue: "Threshold must be ≥ $" + "{{min}}",
      });
    if (parsedThreshold > limits.maxThreshold)
      return t("cloud.autoTopUp.thresholdMax", {
        max: limits.maxThreshold,
        defaultValue: "Threshold can't exceed $" + "{{max}}",
      });
    return null;
  }, [enabled, limits, parsedAmount, parsedThreshold, t]);

  const handleSave = async () => {
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    try {
      const body = await api<BillingSettingsResponse>(ENDPOINT, {
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
      });
      setSettings(body.settings.autoTopUp);
      toast.success(
        t("cloud.autoTopUp.saved", {
          defaultValue: "Auto top-up settings saved",
        }),
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : t("cloud.autoTopUp.saveFailed", {
              defaultValue: "Failed to save settings",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
        </div>
      </BrandCard>
    );
  }

  const noPaymentMethod = settings && !settings.hasPaymentMethod;

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />
            <h3 className="text-base font-mono text-[#e1e1e1] uppercase">
              {t("cloud.autoTopUp.title", {
                defaultValue: "Auto Top-Up (Card)",
              })}
            </h3>
          </div>
          <p className="text-xs font-mono text-[#858585] tracking-tight">
            {t("cloud.autoTopUp.description", {
              defaultValue:
                "Automatically charge your saved card when credits dip below the threshold. Earnings auto-fund runs first, so this only fires if earnings can't cover the gap.",
            })}
          </p>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <Label className="text-white font-mono text-sm">
              {t("cloud.autoTopUp.enableLabel", {
                defaultValue: "Enable card auto top-up",
              })}
            </Label>
            <p className="text-xs font-mono text-[#858585]">
              {settings?.enabled
                ? t("cloud.autoTopUp.activeState", {
                    defaultValue:
                      "Active. Your saved card will be charged automatically.",
                  })
                : t("cloud.autoTopUp.offState", {
                    defaultValue:
                      "Currently off — card won't be charged automatically.",
                  })}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving || !!noPaymentMethod}
            className="data-[state=checked]:bg-[var(--accent)] flex-shrink-0"
          />
        </div>

        {noPaymentMethod && (
          <div className="flex items-start gap-2 border border-yellow-500/30 bg-yellow-500/5 p-3">
            <Info className="h-4 w-4 text-yellow-400 mt-0.5 shrink-0" />
            <p className="text-xs font-mono text-yellow-300">
              {t("cloud.autoTopUp.noPaymentMethod", {
                defaultValue:
                  "No saved payment method. Add a card on the billing page first to enable auto top-up.",
              })}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumericField
            label={t("cloud.autoTopUp.amountLabel", {
              defaultValue: "Top-up amount",
            })}
            description={t("cloud.autoTopUp.amountDescription", {
              defaultValue: "Charged to card each cycle.",
            })}
            value={amount}
            onChange={setAmount}
            disabled={saving || !enabled || !!noPaymentMethod}
            min={limits?.minAmount}
            max={limits?.maxAmount}
          />
          <NumericField
            label={t("cloud.autoTopUp.thresholdLabel", {
              defaultValue: "Trigger threshold",
            })}
            description={t("cloud.autoTopUp.thresholdDescription", {
              defaultValue: "Top-up kicks in below this credit balance.",
            })}
            value={threshold}
            onChange={setThreshold}
            disabled={saving || !enabled || !!noPaymentMethod}
            min={limits?.minThreshold}
            max={limits?.maxThreshold}
          />
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-white/10 pt-4">
          {validationError ? (
            <p className="text-xs font-mono text-red-400 mr-auto">
              {validationError}
            </p>
          ) : null}
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !!validationError || !!noPaymentMethod}
            className="bg-[var(--accent)] hover:bg-[#e54f00] text-white font-mono"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving
              </>
            ) : (
              <>
                <CreditCard className="h-4 w-4 mr-2" /> Save
              </>
            )}
          </Button>
        </div>
      </div>
    </BrandCard>
  );
}

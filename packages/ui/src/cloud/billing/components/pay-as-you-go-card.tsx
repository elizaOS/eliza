/**
 * Pay-as-you-go from earnings — toggle for whether container daily-billing
 * debits the org owner's redeemable_earnings before falling through to org
 * credits. Default on. Off means hosting bills come purely from credits and
 * earnings stay untouched for token cashout.
 *
 * Reads/writes /api/v1/billing/settings (the same endpoint that handles
 * auto-top-up). The toggle is a SettingsSwitchRow hosted in SettingsStack /
 * SettingsGroup.
 */

"use client";

import { Coins, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSwitchRow } from "../../../components/settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Button } from "../../../components/ui/button";
import { api } from "../../lib/api-client";

const ENDPOINT = "/api/v1/billing/settings";
const LOAD_ERROR_MESSAGE =
  "Your current setting is unavailable. Check your connection and retry.";
const SAVE_ERROR_MESSAGE =
  "We couldn't save this billing setting. Your previous setting was restored.";

interface BillingSettingsResponse {
  settings: { payAsYouGoFromEarnings: boolean };
}

export function PayAsYouGoCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const confirmedEnabledRef = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;

    loadInFlightRef.current = true;
    const generation = ++loadGenerationRef.current;
    setLoading(true);

    try {
      const data = await api<BillingSettingsResponse>(ENDPOINT);
      const next = data.settings?.payAsYouGoFromEarnings;
      if (typeof next !== "boolean") {
        throw new TypeError("Billing settings response omitted pay-as-you-go");
      }
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }

      confirmedEnabledRef.current = next;
      setEnabled(next);
      setLoadFailed(false);
    } catch {
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }
      // error-policy:J4 designated settings UI boundary keeps transport and malformed-response failures visibly unavailable and retryable.
      confirmedEnabledRef.current = null;
      setEnabled(null);
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

  const handleToggle = async (next: boolean) => {
    if (saveInFlightRef.current) return;
    const previous = confirmedEnabledRef.current;
    if (previous === null) return;

    saveInFlightRef.current = true;
    const generation = ++saveGenerationRef.current;
    setSaving(true);
    setEnabled(next);
    try {
      await api(ENDPOINT, {
        method: "PUT",
        json: { payAsYouGoFromEarnings: next },
      });
      if (!mountedRef.current || generation !== saveGenerationRef.current) {
        return;
      }

      confirmedEnabledRef.current = next;
      toast.success(
        next
          ? "Earnings will pay container hosting before credits"
          : "Hosting will only use credits — earnings preserved for cashout",
      );
    } catch {
      if (!mountedRef.current || generation !== saveGenerationRef.current) {
        return;
      }
      // error-policy:J4 designated settings UI boundary restores the confirmed value after any transport failure and notifies.
      setEnabled(previous);
      toast.error(SAVE_ERROR_MESSAGE);
    } finally {
      if (mountedRef.current && generation === saveGenerationRef.current) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  };

  const label = "Use my app earnings to pay container hosting";
  const description =
    "When on, daily container bills are paid from your redeemable earnings first, then from credits. When off, hosting bills come purely from credits and your earnings stay untouched (cashout only).";

  return (
    <SettingsStack data-testid="cloud-pay-as-you-go">
      <SettingsGroup title="Pay hosting from earnings">
        {loadFailed ? (
          <div
            role="alert"
            aria-labelledby="cloud-payg-load-error-title"
            aria-describedby="cloud-payg-load-error-description"
            className="rounded-sm border border-danger/30 bg-danger/10 px-3"
          >
            <SettingsRow
              icon={Coins}
              iconClassName="text-danger"
              label={
                <span id="cloud-payg-load-error-title">
                  Couldn't load this billing setting
                </span>
              }
              description={
                <span id="cloud-payg-load-error-description">
                  {LOAD_ERROR_MESSAGE}
                </span>
              }
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-touch"
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
                  Retry
                </Button>
              }
            />
          </div>
        ) : loading || enabled === null ? (
          <SettingsRow
            icon={Coins}
            label={label}
            description={description}
            control={
              <span
                className="flex min-h-11 min-w-11 items-center justify-center"
                role="status"
                aria-busy="true"
                aria-label="Loading pay-as-you-go setting"
              >
                <Loader2
                  className="h-5 w-5 shrink-0 animate-spin text-muted motion-reduce:animate-none"
                  aria-hidden="true"
                />
              </span>
            }
          />
        ) : (
          <SettingsSwitchRow
            agentId="cloud-billing-pay-as-you-go"
            group="cloud-billing"
            icon={Coins}
            label={label}
            description={description}
            checked={enabled}
            disabled={saving}
            onCheckedChange={(next) => void handleToggle(next)}
          />
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}

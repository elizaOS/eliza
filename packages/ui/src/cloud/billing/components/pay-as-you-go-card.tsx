/**
 * Pay-as-you-go from earnings — toggle for whether container daily-billing
 * debits the org owner's redeemable_earnings before falling through to org
 * credits. Default on. Off means hosting bills come purely from credits and
 * earnings stay untouched for token cashout.
 *
 * Reads/writes /api/v1/billing/settings (the same endpoint that handles
 * auto-top-up).
 */

"use client";

import { Coins, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSwitchRow } from "../../../components/settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { ApiError, api } from "../../lib/api-client";

const ENDPOINT = "/api/v1/billing/settings";

interface BillingSettingsResponse {
  settings?: { payAsYouGoFromEarnings?: boolean };
}

export function PayAsYouGoCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const data = await api<BillingSettingsResponse>(ENDPOINT);
    setEnabled(Boolean(data.settings?.payAsYouGoFromEarnings ?? true));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    const previous = enabled;
    setEnabled(next);
    try {
      await api(ENDPOINT, {
        method: "PUT",
        json: { payAsYouGoFromEarnings: next },
      });
      toast.success(
        next
          ? "Earnings will pay container hosting before credits"
          : "Hosting will only use credits — earnings preserved for cashout",
      );
    } catch (error) {
      setEnabled(previous);
      toast.error(error instanceof ApiError ? error.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsStack data-testid="cloud-pay-as-you-go">
      <SettingsGroup title="Pay hosting from earnings">
        {enabled === null ? (
          <SettingsRow
            icon={Coins}
            label="Use my app earnings to pay container hosting"
            description="When on, daily container bills are paid from your redeemable earnings first, then from credits. When off, hosting bills come purely from credits and your earnings stay untouched (cashout only)."
            control={
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted" />
            }
          />
        ) : (
          <SettingsSwitchRow
            agentId="cloud-billing-pay-as-you-go"
            group="cloud-billing"
            icon={Coins}
            label="Use my app earnings to pay container hosting"
            description="When on, daily container bills are paid from your redeemable earnings first, then from credits. When off, hosting bills come purely from credits and your earnings stay untouched (cashout only)."
            checked={enabled}
            disabled={saving}
            onCheckedChange={(next) => void handleToggle(next)}
          />
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}

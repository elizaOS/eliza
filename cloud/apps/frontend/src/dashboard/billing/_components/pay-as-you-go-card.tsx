/**
 * Pay-as-you-go from earnings — toggle for whether container daily-billing
 * debits the org owner's redeemable_earnings before falling through to
 * org credits. Default on. Off means hosting bills come purely from
 * credits and earnings stay untouched for token cashout.
 *
 * Reads/writes /api/v1/billing/settings (the same endpoint that handles
 * auto-top-up).
 */

"use client";

import { BrandCard, CornerBrackets, Label, Switch } from "@elizaos/cloud-ui";
import { Coins, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const ENDPOINT = "/api/v1/billing/settings";

export function PayAsYouGoCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(ENDPOINT);
    if (res.ok) {
      const data = await res.json();
      setEnabled(Boolean(data.settings?.payAsYouGoFromEarnings ?? true));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    const previous = enabled;
    setEnabled(next);
    const res = await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payAsYouGoFromEarnings: next }),
    });
    setSaving(false);
    if (!res.ok) {
      setEnabled(previous);
      const body = await res.json().catch(() => null);
      toast.error(body?.error || "Failed to save");
      return;
    }
    toast.success(
      next
        ? "Earnings will pay container hosting before credits"
        : "Hosting will only use credits — earnings preserved for cashout",
    );
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
          <h3 className="text-base font-mono text-[#e1e1e1] uppercase">
            Pay Hosting From Earnings
          </h3>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 flex-1 min-w-0">
            <Label className="text-white font-mono text-sm flex items-center gap-2">
              <Coins className="h-4 w-4 text-[#FF5800]" />
              Use my app earnings to pay container hosting
            </Label>
            <p className="text-xs font-mono text-[#858585] leading-relaxed">
              When on, daily container bills are paid from your redeemable earnings first, then from
              credits. When off, hosting bills come purely from credits and your earnings stay
              untouched (cashout only).
            </p>
          </div>
          {enabled === null ? (
            <Loader2 className="h-5 w-5 animate-spin text-[#FF5800] flex-shrink-0" />
          ) : (
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={saving}
              className="data-[state=checked]:bg-[#FF5800] flex-shrink-0"
            />
          )}
        </div>
      </div>
    </BrandCard>
  );
}

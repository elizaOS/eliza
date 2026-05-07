/**
 * One-click copy of `{origin}/login?ref=…` for signed-in dashboard users.
 *
 * WHY fetch on each click (no in-memory cache of `ReferralMeResponse`): Every click calls
 * GET `/api/v1/referrals` so `is_active` matches the server; concurrent clicks dedupe via
 * `inFlightRef` only.
 *
 * WHY in-flight dedupe: Concurrent clicks share one promise so we do not spam `getOrCreateCode`.
 *
 * WHY block copy when `!is_active`: Apply rejects inactive codes; sharing would waste invitees’ time.
 *
 * Clipboard: `copyTextToClipboard` falls back to `document.execCommand('copy')` when the Clipboard
 * API is unavailable (e.g. plain HTTP). Production dashboard should still use HTTPS.
 */
"use client";

import { Loader2, UserPlus } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { ReferralMeResponse } from "@/lib/types/referral-me";
import { copyTextToClipboard } from "@/lib/utils/copy-to-clipboard";
import { buildReferralInviteLoginUrl } from "@/lib/utils/referral-invite-url";
import { fetchReferralMe } from "@/lib/utils/referral-me-fetch";
import { BrandButton } from "@elizaos/cloud-ui/components/brand/brand-button";

export function HeaderInviteButton() {
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef<Promise<ReferralMeResponse> | null>(null);

  const resolveMe = useCallback(async (): Promise<ReferralMeResponse> => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const promise = fetchReferralMe();

    inFlightRef.current = promise;
    return promise.finally(() => {
      inFlightRef.current = null;
    });
  }, []);

  const onClick = useCallback(async () => {
    if (typeof window === "undefined") return;
    const origin = window.location.origin;
    if (!origin) {
      toast.error("Could not build invite link");
      return;
    }

    setLoading(true);
    try {
      const me = await resolveMe().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "Could not load invite link";
        toast.error(msg);
        return null;
      });

      if (!me) return;

      if (!me.is_active) {
        toast.error("Your invite link is inactive and cannot be shared.");
        return;
      }

      const url = buildReferralInviteLoginUrl(origin, me.code);
      const ok = await copyTextToClipboard(url);
      if (ok) {
        toast.success("Invite link copied!");
      } else {
        toast.error("Could not copy to clipboard");
      }
    } finally {
      setLoading(false);
    }
  }, [resolveMe]);

  return (
    <BrandButton
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 shrink-0 border-white/10 bg-white/5 px-2 md:h-10 md:w-auto md:gap-2 md:px-3"
      onClick={() => void onClick()}
      disabled={loading}
      aria-label="Copy invite link"
      title="Copy invite link"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-white" />
      ) : (
        <UserPlus className="h-4 w-4 text-white" />
      )}
      <span className="hidden md:inline text-sm text-white">Invite</span>
    </BrandButton>
  );
}

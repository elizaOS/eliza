"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReferralMeResponse } from "@/lib/types/referral-me";
import { fetchReferralMe } from "@/lib/utils/referral-me-fetch";

export interface UseDashboardReferralMeResult {
  referralMe: ReferralMeResponse | null;
  loadingReferral: boolean;
  referralFetchFailed: boolean;
  /** Re-fetch referral data (e.g. after a transient network failure). */
  refetch: () => void;
}

/**
 * Hook to fetch and manage referral data for the dashboard.
 *
 * Note: Uses stale-while-revalidate pattern — on refetch(), loadingReferral
 * becomes true while referralMe retains its previous value. This allows UI to
 * show existing data with a loading indicator rather than flashing to empty state.
 */
export function useDashboardReferralMe(): UseDashboardReferralMeResult {
  const [referralMe, setReferralMe] = useState<ReferralMeResponse | null>(null);
  const [loadingReferral, setLoadingReferral] = useState(true);
  const [referralFetchFailed, setReferralFetchFailed] = useState(false);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setFetchTrigger((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchTrigger;

    const load = async () => {
      setLoadingReferral(true);
      setReferralFetchFailed(false);
      try {
        const parsed = await fetchReferralMe();
        if (!cancelled) {
          setReferralMe(parsed);
        }
      } catch {
        if (!cancelled) {
          setReferralFetchFailed(true);
        }
      } finally {
        if (!cancelled) {
          setLoadingReferral(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchTrigger]);

  return { referralMe, loadingReferral, referralFetchFailed, refetch };
}

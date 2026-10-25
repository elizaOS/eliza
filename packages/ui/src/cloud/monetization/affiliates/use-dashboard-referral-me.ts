/**
 * Hook to fetch + manage referral data for the affiliates surface.
 *
 * Stale-while-revalidate: on `refetch()`, `loadingReferral` becomes true while
 * `referralMe` retains its previous value, so the UI shows existing data with a
 * loading indicator rather than flashing to an empty state.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchReferralMe, type ReferralMeResponse } from "./referral-me";

export interface UseDashboardReferralMeResult {
  referralMe: ReferralMeResponse | null;
  loadingReferral: boolean;
  referralFetchFailed: boolean;
  /** Re-fetch referral data (e.g. after a transient network failure). */
  refetch: () => void;
}

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

import { useEffect, useRef } from "react";
import type { AppState } from "../../../state/types";

type ElizaCloudTab = AppState["onboardingElizaCloudTab"];

/**
 * Eliza Cloud inside the **connection** wizard step (not the short `cloudLogin` track).
 *
 * **WHY auto-advance:** parity with `CloudLoginStep` — once `elizaCloudConnected` is
 * true and the UI shows connected, a second Confirm was redundant UX.
 *
 * **WHY Login tab only:** on API key tab the user may still be typing; advancing on a
 * stale `elizaCloudConnected` flag would be wrong.
 *
 * **WHY ref + reset on disconnect:** the same mount can see connect → disconnect →
 * connect again; allow a second advance without relying on remount.
 */
export function useAdvanceOnboardingWhenElizaCloudOAuthConnected(options: {
  /** When false (e.g. another provider selected), do not advance and reset guard. */
  active: boolean;
  elizaCloudConnected: boolean;
  elizaCloudTab: ElizaCloudTab;
  handleOnboardingNext: () => void | Promise<void>;
}): void {
  const { active, elizaCloudConnected, elizaCloudTab, handleOnboardingNext } =
    options;
  const advancedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      advancedRef.current = false;
      return;
    }
    if (!elizaCloudConnected) {
      advancedRef.current = false;
      return;
    }
    if (elizaCloudTab !== "login" || advancedRef.current) return;
    advancedRef.current = true;
    void handleOnboardingNext();
  }, [active, elizaCloudConnected, elizaCloudTab, handleOnboardingNext]);
}

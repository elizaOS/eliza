import {
  type ActionNotice,
  LoadingScreen,
  type Tab,
  useRenderGuard,
} from "@elizaos/ui";
import { memo, useEffect, useState } from "react";
import { getVrmCount, getVrmUrl, VRM_COUNT } from "../../vrm-assets";
import { prefetchVrmToCache } from "../avatar/VrmEngine";
import { CompanionView } from "./CompanionView";

export { COMPANION_OVERLAY_TABS } from "./companion-shell-styles";

/* ── Main component ────────────────────────────────────────────────── */

export interface CompanionShellProps {
  tab: Tab;
  actionNotice: ActionNotice | null;
}

export const CompanionShell = memo(function CompanionShell(
  _props: CompanionShellProps,
) {
  useRenderGuard("CompanionShell");

  // The first time the companion mounts, VRM buffers may not be in cache
  // yet — render the LoadingScreen until every prefetch settles so the
  // user doesn't see a flash of empty stage before the avatar can parse.
  // Prefetch is best-effort (network errors are swallowed by VrmEngine);
  // we await Promise.allSettled so a single failed asset doesn't block
  // the rest of the UI from coming up.
  const [vrmsReady, setVrmsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const total = getVrmCount() || VRM_COUNT;
    const work: Array<Promise<void>> = [];
    for (let i = 1; i <= total; i++) {
      work.push(prefetchVrmToCache(getVrmUrl(i)));
    }
    Promise.allSettled(work).then(() => {
      if (!cancelled) setVrmsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!vrmsReady) {
    // Prime the loader's staged-fetch UI with the first VRM so users see
    // a real percentage instead of an empty bar.
    return <LoadingScreen phase="ready" vrmUrl={getVrmUrl(1)} />;
  }

  return (
    <div
      data-testid="companion-root"
      className="relative h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]"
    >
      <CompanionView />
    </div>
  );
});

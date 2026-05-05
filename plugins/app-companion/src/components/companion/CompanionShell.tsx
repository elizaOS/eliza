import { type ActionNotice, type Tab, useRenderGuard } from "@elizaos/app-core";
import { memo, useEffect } from "react";
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

  // Warm the in-memory VRM buffer cache as soon as the companion shell
  // mounts. Fire-and-forget — VrmEngine swallows errors. This used to
  // run during global startup-phase-hydrate, but VRM downloads only
  // matter when the companion scene is actually about to render.
  useEffect(() => {
    const total = getVrmCount() || VRM_COUNT;
    for (let i = 1; i <= total; i++) {
      void prefetchVrmToCache(getVrmUrl(i));
    }
  }, []);

  return (
    <div
      data-testid="companion-root"
      className="relative h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]"
    >
      <CompanionView />
    </div>
  );
});

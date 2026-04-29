import { type ActionNotice, type Tab, useRenderGuard } from "@elizaos/app-core";
import { memo } from "react";
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
  return (
    <div
      data-testid="companion-root"
      className="relative h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]"
    >
      <CompanionView />
    </div>
  );
});

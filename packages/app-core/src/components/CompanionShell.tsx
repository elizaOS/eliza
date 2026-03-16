/**
 * Companion shell — renders CompanionView (VRM + chat dock).
 *
 * Used when `uiShellMode === "companion"`. Settings, character, skills, etc.
 * require switching to native (advanced) mode via the header toggle.
 */

import { useRenderGuard } from "@elizaos/app-core/hooks";
import type { Tab } from "@elizaos/app-core/navigation";
import { memo } from "react";
import { CompanionView } from "./CompanionView";

export { COMPANION_OVERLAY_TABS } from "./companion-shell-styles";

/* ── Main component ────────────────────────────────────────────────── */

export interface CompanionShellProps {
  tab: Tab;
  actionNotice: { text: string; tone: string } | null;
}

export const CompanionShell = memo(function CompanionShell(
  _props: CompanionShellProps,
) {
  useRenderGuard("CompanionShell");
  return (
    <div className="relative w-full h-[100vh] overflow-hidden">
      <CompanionView />
    </div>
  );
});

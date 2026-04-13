/**
 * Companion shell — renders CompanionView (VRM + chat dock).
 *
 * Used when `uiShellMode === "companion"`. Settings, character, skills, etc.
 * require switching to native (advanced) mode via the header toggle.
 */

import { useRenderGuard } from "@elizaos/app-core/hooks";
import type { Tab } from "@elizaos/app-core/navigation";
import type { ActionNotice } from "@elizaos/app-core/state";
import { memo } from "react";
import { CompanionView } from "../pages/CompanionView";

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
    <div className="relative h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]">
      <CompanionView />
    </div>
  );
});

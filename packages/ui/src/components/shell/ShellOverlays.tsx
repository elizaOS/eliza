import { Spinner, Z_SHELL_OVERLAY } from "@elizaos/ui";
import type { ActionNotice } from "../../state/types";
import { CompanionGlobalOverlay as GlobalEmoteOverlay } from "../companion/injected";
import { BugReportModal } from "./BugReportModal";
import { CommandPalette } from "./CommandPalette";
import { ComputerUseApprovalOverlay } from "./ComputerUseApprovalOverlay";

import { RestartBanner } from "./RestartBanner";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

export function ShellOverlays({
  actionNotice,
}: {
  actionNotice: ActionNotice | null;
}) {
  return (
    <>
      <CommandPalette />
      <RestartBanner />
      <BugReportModal />
      <ComputerUseApprovalOverlay />
      <ShortcutsOverlay />
      <GlobalEmoteOverlay />
      {actionNotice && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-lg text-sm font-medium z-[${Z_SHELL_OVERLAY}] flex items-center gap-2.5 max-w-[min(92vw,28rem)] ${
            actionNotice.tone === "error"
              ? "bg-danger text-white"
              : actionNotice.tone === "success"
                ? "bg-ok text-white"
                : "bg-accent text-accent-fg"
          }`}
          role="status"
          aria-live="polite"
          aria-busy={actionNotice.busy ? true : undefined}
        >
          {actionNotice.busy ? (
            <Spinner size={16} className="shrink-0 opacity-95" aria-hidden />
          ) : null}
          <span className="text-left leading-snug">{actionNotice.text}</span>
        </div>
      )}
    </>
  );
}

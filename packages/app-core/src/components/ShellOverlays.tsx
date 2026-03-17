import { GlobalEmoteOverlay } from "./GlobalEmoteOverlay";
import {
  BugReportModal,
  CommandPalette,
  RestartBanner,
  ShortcutsOverlay,
} from "./index";

export interface ActionNotice {
  text: string;
  tone: string;
}

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
      <ShortcutsOverlay />
      <GlobalEmoteOverlay />
      {actionNotice && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-2 rounded-lg text-[13px] font-medium z-[10000] text-white ${
            actionNotice.tone === "error"
              ? "bg-danger"
              : actionNotice.tone === "success"
                ? "bg-ok"
                : "bg-accent"
          }`}
        >
          {actionNotice.text}
        </div>
      )}
    </>
  );
}

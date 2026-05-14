import { useEffect } from "react";
import { SHARE_TARGET_EVENT } from "../../events";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import type { ShareTargetPayload } from "../../platform/init";
import type { ActionNotice } from "../../state/types";
import { useApp } from "../../state/useApp";
import { CompanionGlobalOverlay as GlobalEmoteOverlay } from "../companion/injected";
import { Spinner } from "../ui/spinner";
import { BugReportModal } from "./BugReportModal";
import { CommandPalette } from "./CommandPalette";
import { ComputerUseApprovalOverlay } from "./ComputerUseApprovalOverlay";

import { RestartBanner } from "./RestartBanner";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

interface SharedWindow extends Window {
  __ELIZA_APP_SHARE_QUEUE__?: ShareTargetPayload[];
  __ELIZAOS_SHARE_QUEUE__?: ShareTargetPayload[];
}

function drainShareQueue(): ShareTargetPayload[] {
  if (typeof window === "undefined") return [];
  const w = window as SharedWindow;
  const drained: ShareTargetPayload[] = [];
  const elizaAppQueue = w.__ELIZA_APP_SHARE_QUEUE__;
  if (Array.isArray(elizaAppQueue) && elizaAppQueue.length > 0) {
    drained.push(...elizaAppQueue.splice(0));
  }
  const elizaosQueue = w.__ELIZAOS_SHARE_QUEUE__;
  if (Array.isArray(elizaosQueue) && elizaosQueue.length > 0) {
    drained.push(...elizaosQueue.splice(0));
  }
  return drained;
}

function formatSharePayload(payload: ShareTargetPayload): string {
  const parts = [payload.title, payload.text, payload.url]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  if (parts.length > 0) return parts.join("\n");
  const fileNames = (payload.files ?? [])
    .map((file) => file?.name?.trim())
    .filter((name): name is string => !!name && name.length > 0);
  return fileNames.length > 0 ? fileNames.join(", ") : "";
}

export function ShellOverlays({
  actionNotice,
}: {
  actionNotice: ActionNotice | null;
}) {
  const { tab, setState, setActionNotice } = useApp();

  useEffect(() => {
    const handlePayload = (payload: ShareTargetPayload) => {
      const text = formatSharePayload(payload);
      if (!text) return;
      if (tab === "chat") {
        setState("chatInput", text);
        return;
      }
      const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
      setActionNotice(`Shared: ${preview}`, "info", 4000);
    };

    for (const queued of drainShareQueue()) {
      handlePayload(queued);
    }

    const onShare = (event: Event) => {
      const detail = (event as CustomEvent<ShareTargetPayload>).detail;
      if (!detail || typeof detail !== "object") return;
      handlePayload(detail);
      drainShareQueue();
    };

    document.addEventListener(SHARE_TARGET_EVENT, onShare);
    return () => {
      document.removeEventListener(SHARE_TARGET_EVENT, onShare);
    };
  }, [tab, setState, setActionNotice]);

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

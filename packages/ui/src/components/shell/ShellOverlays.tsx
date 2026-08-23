/**
 * Aggregates the shell's floating overlays into one render slot: the dev perf
 * HUD, command palette, restart banner, bug-report modal, computer-use approval
 * overlay, keyboard-shortcuts overlay, and the transient action-notice toast.
 *
 * Also owns the share-target sink: drains any queued OS share payloads and
 * subscribes to SHARE_TARGET_EVENT, routing shared text into the chat composer
 * when the chat tab is active or surfacing it as a toast otherwise. Mounts the
 * layout-shift + frame-budget monitors that feed the perf HUD.
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import { SHARE_TARGET_EVENT } from "../../events";
import { useFrameBudgetMonitor, useLayoutShiftMonitor } from "../../hooks";
import { PerfOverlay } from "../../perf/PerfOverlay";
import { bootPerfHud, installPerfHudHotkey } from "../../perf/perf-hud-control";
import type { ShareTargetPayload } from "../../platform/init";

import { TOAST_TTL_MS } from "../../state/action-notice";
import { useAppSelector } from "../../state/app-store";
import type { AppContextValue } from "../../state/internal";
import type { ActionNotice } from "../../state/types";
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

const selectTab = (s: AppContextValue) => s.tab;
const selectSetState = (s: AppContextValue) => s.setState;
const selectSetActionNotice = (s: AppContextValue) => s.setActionNotice;
const selectFirstRunComplete = (s: AppContextValue) => s.firstRunComplete;

export function ActionNoticeToast({
  notice,
  onDismiss,
}: {
  notice: ActionNotice;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[10000] w-max max-w-[min(92vw,28rem)] -translate-x-1/2">
      <div
        className={`flex items-center gap-2.5 rounded-sm py-2.5 pr-1.5 pl-5 text-sm font-medium ${
          notice.tone === "error"
            ? "bg-danger text-white"
            : notice.tone === "success"
              ? "bg-ok text-white"
              : "bg-accent text-accent-fg"
        }`}
        data-testid="shell-action-notice"
        data-tone={notice.tone}
      >
        <div
          className="flex min-w-0 items-center gap-2.5"
          role="status"
          aria-live="polite"
          aria-busy={notice.busy ? true : undefined}
        >
          {notice.busy ? (
            <Spinner size={16} className="shrink-0 opacity-95" aria-hidden />
          ) : null}
          <span className="text-left leading-snug">{notice.text}</span>
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
          className="pointer-events-auto -my-2 -mr-1 ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-current/85 transition-colors hover:bg-white/15 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <X aria-hidden className="h-4 w-4" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

export function ShellOverlays({
  actionNotice,
}: {
  actionNotice: ActionNotice | null;
}) {
  const tab = useAppSelector(selectTab);
  const setState = useAppSelector(selectSetState);
  const setActionNotice = useAppSelector(selectSetActionNotice);
  const firstRunComplete = useAppSelector(selectFirstRunComplete);

  useLayoutShiftMonitor({ enabled: firstRunComplete !== false });
  useFrameBudgetMonitor();

  useEffect(() => {
    bootPerfHud();
    return installPerfHudHotkey();
  }, []);

  useEffect(() => {
    const handlePayload = (payload: ShareTargetPayload) => {
      const text = formatSharePayload(payload);
      if (!text) return;
      if (tab === "chat") {
        setState("chatInput", text);
        return;
      }
      const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
      setActionNotice(`Shared: ${preview}`, "info", TOAST_TTL_MS.notification);
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
      {/* Dev-only FPS/long-task overlay (#9141) — self-gates on
          window.__ELIZA_PERF_HUD__, renders null + starts no loop when off. */}
      <PerfOverlay />
      <CommandPalette />
      <RestartBanner />
      <BugReportModal />
      <ComputerUseApprovalOverlay />
      <ShortcutsOverlay />
      {actionNotice && (
        <ActionNoticeToast
          notice={actionNotice}
          onDismiss={() => setState("actionNotice", null)}
        />
      )}
    </>
  );
}

import { useApp, type CodingAgentSession } from "@elizaos/app-core";
import { useCallback, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { PtyTerminalPane } from "./PtyTerminalPane";
import { PULSE_STATUSES, STATUS_DOT } from "./pty-status-dots";

export interface PtyConsoleBaseProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
  variant: "drawer" | "side-panel";
}

/** Chevron-down icon for drawer close button. */
const DrawerCloseIcon = (
  <svg
    aria-hidden="true"
    focusable="false"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 13l5 5 5-5M7 6l5 5 5-5" />
  </svg>
);

/** X icon for side-panel close button. */
const SidePanelCloseIcon = (
  <svg
    aria-hidden="true"
    focusable="false"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

/**
 * Shared base for PTY console UIs. Renders the tab bar, session selection
 * state, status dots, and terminal panes. Drawer and side-panel variants
 * wrap this with their own container/layout styling.
 */
export function PtyConsoleBase({
  activeSessionId,
  sessions,
  onClose,
  variant,
}: PtyConsoleBaseProps) {
  const { t } = useApp();
  const [selectedId, setSelectedId] = useState(activeSessionId);

  const resolvedId =
    sessions.find((s) => s.sessionId === selectedId)?.sessionId ??
    sessions[0]?.sessionId;

  const handleTabClick = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  if (!sessions.length) return null;

  const isSidePanel = variant === "side-panel";
  const closeIcon = isSidePanel ? SidePanelCloseIcon : DrawerCloseIcon;
  const closeLabel = isSidePanel
    ? t("aria.closeConsolePanel")
    : t("aria.closeConsole");

  return (
    <>
      {/* Side-panel has a separate header row */}
      {isSidePanel && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <span className="text-xs font-semibold text-txt">
            {t("ptyconsolebase.AgentConsoles")}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted hover:text-txt transition-colors cursor-pointer rounded hover:bg-bg-hover"
            aria-label={closeLabel}
          >
            {closeIcon}
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div
        className={`flex items-center gap-0 border-b border-border px-2 shrink-0${isSidePanel ? " overflow-x-auto" : ""}`}
      >
        {sessions.map((s) => {
          const isActive = s.sessionId === resolvedId;
          return (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => handleTabClick(s.sessionId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-b-2 transition-colors cursor-pointer${isSidePanel ? " whitespace-nowrap" : ""} ${
                isActive
                  ? "border-accent text-txt"
                  : "border-transparent text-muted hover:text-txt"
              }`}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                  STATUS_DOT[s.status] ?? "bg-muted"
                }${PULSE_STATUSES.has(s.status) ? " animate-pulse" : ""}`}
              />
              <span
                className={`truncate ${isSidePanel ? "max-w-[120px]" : "max-w-[100px]"}`}
              >
                {s.label}
              </span>
            </button>
          );
        })}

        {/* Drawer puts the close button inline in the tab bar */}
        {!isSidePanel && (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1 text-muted hover:text-txt transition-colors cursor-pointer"
            aria-label={closeLabel}
          >
            {closeIcon}
          </button>
        )}
      </div>

      {/* Terminal panes */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {sessions.map((s) => (
          <PtyTerminalPane
            key={s.sessionId}
            sessionId={s.sessionId}
            visible={s.sessionId === resolvedId}
          />
        ))}
      </div>
    </>
  );
}

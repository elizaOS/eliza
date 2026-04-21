import { ChevronLeft, ChevronRight, MessageSquare } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { ChatView } from "../pages/ChatView.js";

export const APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY =
  "app-workspace-chrome:chat-collapsed";

export interface AppWorkspaceChromeProps {
  /** Optional nav region rendered above the main pane. */
  nav?: ReactNode;
  /** Required main content area. */
  main: ReactNode;
  /**
   * Chat content for the right sidebar. When omitted a shared
   * `<ChatView variant="default" />` is rendered.
   */
  chat?: ReactNode;
  /**
   * Controlled: current collapsed state.
   * When provided, `onToggleChat` must also be provided.
   */
  chatCollapsed?: boolean;
  /**
   * Controlled: callback when the user toggles the sidebar.
   * Receives the next collapsed boolean.
   */
  onToggleChat?: (next: boolean) => void;
  /**
   * Uncontrolled: initial collapsed state.
   * Ignored when `chatCollapsed` is provided.
   * Defaults to the value persisted in localStorage, then `false`.
   */
  chatDefaultCollapsed?: boolean;
  /** data-testid applied to the root element. */
  testId?: string;
}

function readStoredCollapsed(defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  const stored = window.localStorage.getItem(
    APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY,
  );
  if (stored === null) return defaultValue;
  return stored === "true";
}

/** Pure-layout chrome: main pane + collapsible right-side chat sidebar. */
export function AppWorkspaceChrome({
  nav,
  main,
  chat,
  chatCollapsed: chatCollapsedProp,
  onToggleChat,
  chatDefaultCollapsed = false,
  testId = "app-workspace-chrome",
}: AppWorkspaceChromeProps): JSX.Element {
  const isControlled = chatCollapsedProp !== undefined;

  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(() =>
    isControlled
      ? (chatCollapsedProp ?? false)
      : readStoredCollapsed(chatDefaultCollapsed),
  );

  // Keep internal state in sync when switching from uncontrolled → controlled.
  const prevIsControlled = useRef(isControlled);
  useEffect(() => {
    if (!prevIsControlled.current && isControlled) {
      setInternalCollapsed(chatCollapsedProp ?? false);
    }
    prevIsControlled.current = isControlled;
  }, [isControlled, chatCollapsedProp]);

  const collapsed = isControlled
    ? (chatCollapsedProp ?? false)
    : internalCollapsed;

  function handleToggle(next: boolean) {
    if (isControlled) {
      onToggleChat?.(next);
    } else {
      setInternalCollapsed(next);
      try {
        window.localStorage.setItem(
          APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY,
          String(next),
        );
      } catch {
        // localStorage may be unavailable in some sandboxed environments.
      }
    }
  }

  const chatContent = chat ?? <ChatView variant="default" />;

  return (
    <div className="flex min-h-0 flex-1 bg-bg" data-testid={testId}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {nav}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {main}
        </div>
      </div>

      {/* Collapsible right-side chat sidebar */}
      <aside
        className={`flex shrink-0 flex-col border-l border-border/30 bg-bg transition-[width] duration-200 ${
          collapsed ? "w-10" : "w-[24rem]"
        }`}
        data-testid={`${testId}-chat-sidebar`}
      >
        <div className="flex h-10 items-center justify-between border-b border-border/30 px-2">
          {collapsed ? (
            <button
              type="button"
              className="mx-auto flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
              aria-label="Expand chat"
              onClick={() => handleToggle(false)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : (
            <>
              <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                <MessageSquare className="h-3.5 w-3.5" />
                Chat
              </div>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
                aria-label="Collapse chat"
                onClick={() => handleToggle(true)}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        {collapsed ? null : (
          <div className="flex min-h-0 flex-1 flex-col">{chatContent}</div>
        )}
      </aside>
    </div>
  );
}

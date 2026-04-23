import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type React from "react";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useMediaQuery } from "../../hooks";
import { ChatView } from "../pages/ChatView.js";
import {
  PageScopedChatPane,
  type PageScopedChatPaneProps,
} from "../pages/PageScopedChatPane.js";
import type { PageScope } from "../pages/page-scoped-conversations.js";

export const APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY =
  "app-workspace-chrome:chat-collapsed";
export const APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY =
  "app-workspace-chrome:chat-width";

const CHAT_DEFAULT_WIDTH = 384;
const CHAT_MIN_WIDTH = 240;
const CHAT_MAX_WIDTH = 640;
const WORKSPACE_MOBILE_MEDIA_QUERY = "(max-width: 639px)";

interface AppWorkspaceChatChromeContextValue {
  collapseChat: () => void;
}

const AppWorkspaceChatChromeContext =
  createContext<AppWorkspaceChatChromeContextValue | null>(null);

export function useAppWorkspaceChatChrome(): AppWorkspaceChatChromeContextValue | null {
  return useContext(AppWorkspaceChatChromeContext);
}

interface AppWorkspaceChatCollapseButtonProps {
  testId?: string;
}

export function AppWorkspaceChatCollapseButton({
  testId = "app-workspace-chat-collapse",
}: AppWorkspaceChatCollapseButtonProps): JSX.Element | null {
  const chatChrome = useAppWorkspaceChatChrome();

  if (!chatChrome) return null;

  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
      aria-label="Collapse chat"
      onClick={() => chatChrome.collapseChat()}
    >
      <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

function clampWidth(value: number): number {
  return Math.min(Math.max(value, CHAT_MIN_WIDTH), CHAT_MAX_WIDTH);
}

export interface AppWorkspaceChromeProps {
  /** Optional nav region rendered above the main pane. */
  nav?: ReactNode;
  /** Required main content area. */
  main: ReactNode;
  /**
   * Chat content for the right sidebar. When omitted a shared
   * `<ChatView variant="default" />` is rendered, unless `chatScope` is set.
   */
  chat?: ReactNode;
  /**
   * Page-scoped assistant context for workspace pages whose right rail should
   * explain and act within the current surface instead of the global chat.
   */
  chatScope?: PageScope;
  /**
   * Optional overrides forwarded into the shared page-scoped chat pane when
   * `chatScope` is provided.
   */
  pageScopedChatPaneProps?: Omit<PageScopedChatPaneProps, "scope" | "footerActions">;
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
  /** Hide the default bottom-right collapse control when chat content owns it. */
  hideCollapseButton?: boolean;
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

function readStoredWidth(): number {
  if (typeof window === "undefined") return CHAT_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(
      APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY,
    );
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed)) return clampWidth(parsed);
  } catch {
    /* ignore sandboxed storage */
  }
  return CHAT_DEFAULT_WIDTH;
}

/** Pure-layout chrome: main pane + collapsible right-side chat sidebar. */
export function AppWorkspaceChrome({
  nav,
  main,
  chat,
  chatScope,
  pageScopedChatPaneProps,
  chatCollapsed: chatCollapsedProp,
  onToggleChat,
  chatDefaultCollapsed = false,
  hideCollapseButton = false,
  testId = "app-workspace-chrome",
}: AppWorkspaceChromeProps): JSX.Element {
  const isControlled = chatCollapsedProp !== undefined;
  const isMobileViewport = useMediaQuery(WORKSPACE_MOBILE_MEDIA_QUERY);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

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
  const effectiveCollapsed = isMobileViewport ? !mobileChatOpen : collapsed;

  const handleToggle = useCallback(
    (next: boolean) => {
      if (isMobileViewport) {
        setMobileChatOpen(!next);
        return;
      }
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
    },
    [isControlled, isMobileViewport, onToggleChat],
  );

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileChatOpen(false);
    }
  }, [isMobileViewport]);

  // Persisted horizontal resize — mirrors the chat view's widgets-bar
  // resize/collapse affordances so the chrome feels consistent across pages.
  const [chatWidth, setChatWidth] = useState<number>(readStoredWidth);
  const applyChatWidth = useCallback((next: number) => {
    setChatWidth(next);
    try {
      window.localStorage.setItem(
        APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY,
        String(next),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const collapseThreshold = Math.max(CHAT_MIN_WIDTH - 40, 80);
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (effectiveCollapsed || isMobileViewport) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = chatWidth;
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      const onMove = (ev: PointerEvent) => {
        // Handle sits on the LEFT edge of a RIGHT-side pane — dragging
        // leftwards (negative delta) increases width.
        const delta = ev.clientX - startX;
        const nextRaw = startWidth - delta;
        if (nextRaw < collapseThreshold) {
          handleToggle(true);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          return;
        }
        applyChatWidth(clampWidth(nextRaw));
      };
      const onUp = () => {
        try {
          target.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [
      applyChatWidth,
      chatWidth,
      collapseThreshold,
      effectiveCollapsed,
      handleToggle,
      isMobileViewport,
    ],
  );

  const pageScopedChatOwnsCollapse = chat === undefined && chatScope !== undefined;

  const chatContent =
    chat ??
    (chatScope ? (
      <PageScopedChatPane
        {...pageScopedChatPaneProps}
        scope={chatScope}
        footerActions={
          <AppWorkspaceChatCollapseButton
            testId={`${testId}-chat-collapse-inline`}
          />
        }
      />
    ) : (
      <ChatView variant="default" />
    ));

  return (
    <div
      className="flex min-h-0 min-w-0 w-full flex-1 bg-bg pb-[var(--eliza-mobile-nav-offset,0px)]"
      data-testid={testId}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {nav}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {main}
        </div>
      </div>

      {/* Collapsible right-side chat sidebar */}
      {effectiveCollapsed ? (
        <aside
          className="w-0 min-w-0 shrink-0"
          data-testid={`${testId}-chat-sidebar`}
          data-collapsed
        >
          <button
            type="button"
            data-testid={`${testId}-chat-expand`}
            className={
              isMobileViewport
                ? "fixed right-2 top-[var(--safe-area-top,0px)] z-50 inline-flex h-[2.375rem] w-[2.375rem] items-center justify-center rounded-md border border-transparent bg-transparent text-muted transition-colors hover:text-txt"
                : "fixed bottom-3 right-3 z-40 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] border border-border/40 bg-card/85 text-muted shadow-md backdrop-blur-md transition-colors hover:border-border/60 hover:text-txt"
            }
            aria-label="Open page chat"
            onClick={() => handleToggle(false)}
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        </aside>
      ) : (
        <>
          {isMobileViewport ? (
            <button
              type="button"
              className="fixed inset-x-0 z-40 bg-bg/65 backdrop-blur-[2px]"
              style={{
                top: "calc(var(--safe-area-top, 0px) + 2.375rem)",
                bottom: "calc(3.625rem + var(--safe-area-bottom, 0px))",
              }}
              aria-label="Close page chat"
              onClick={() => handleToggle(true)}
              data-testid={`${testId}-chat-backdrop`}
            />
          ) : null}
          <aside
            className={
              isMobileViewport
                ? "fixed right-0 z-50 flex w-[min(24rem,92vw)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden bg-bg shadow-2xl"
                : "relative flex shrink-0 flex-col overflow-hidden bg-bg"
            }
            style={
              isMobileViewport
                ? {
                    top: "calc(var(--safe-area-top, 0px) + 2.375rem)",
                    bottom: "calc(3.625rem + var(--safe-area-bottom, 0px))",
                  }
                : { width: `${chatWidth}px`, minWidth: `${chatWidth}px` }
            }
            data-testid={`${testId}-chat-sidebar`}
          >
            {isMobileViewport ? null : (
              <hr
                aria-label="Resize chat"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={50}
                tabIndex={0}
                data-testid={`${testId}-chat-resize-handle`}
                onPointerDown={handleResizePointerDown}
                className="absolute inset-y-0 left-0 z-20 m-0 h-full w-3 -translate-x-1/2 cursor-col-resize touch-none select-none border-0 bg-transparent transition-colors hover:bg-accent/20"
              />
            )}
            <AppWorkspaceChatChromeContext.Provider
              value={{
                collapseChat: () => handleToggle(true),
              }}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {chatContent}
              </div>
              {hideCollapseButton || pageScopedChatOwnsCollapse ? null : (
                <div className="flex items-center justify-end pl-2 pr-2 pt-1.5 pb-2">
                  <AppWorkspaceChatCollapseButton
                    testId={`${testId}-chat-collapse`}
                  />
                </div>
              )}
            </AppWorkspaceChatChromeContext.Provider>
          </aside>
        </>
      )}
    </div>
  );
}

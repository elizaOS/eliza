import { type WorkspaceMobileSidebarControl, type WorkspaceMobileSidebarControls, WorkspaceMobileSidebarControlsContext } from "../../layouts/workspace-layout/workspace-mobile-sidebar-controls";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type React from "react";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
const WORKSPACE_MOBILE_MEDIA_QUERY = "(max-width: 819px)";

interface AppWorkspaceChatChromeContextValue {
  collapseChat: () => void;
  openChat: () => void;
  isChatOpen: boolean;
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

interface AppWorkspaceChatDockToggleButtonProps {
  collapsed: boolean;
  testId: string;
}

function AppWorkspaceChatDockToggleButton({
  collapsed,
  testId,
}: AppWorkspaceChatDockToggleButtonProps): JSX.Element | null {
  const chatChrome = useAppWorkspaceChatChrome();

  if (!chatChrome) return null;

  return (
    <button
      type="button"
      data-testid={testId}
      className="fixed bottom-2 right-2 z-40 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
      aria-label={collapsed ? "Open page chat" : "Collapse chat"}
      onClick={() =>
        collapsed ? chatChrome.openChat() : chatChrome.collapseChat()
      }
    >
      {collapsed ? (
        <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

function MobileWorkspacePaneSwitcher({
  chatAvailable,
  chatOpen,
  sidebar,
  onChat,
  onSidebar,
  onCloseChat,
  onCloseSidebar,
}: {
  chatAvailable: boolean;
  chatOpen: boolean;
  sidebar: WorkspaceMobileSidebarControl | null;
  onChat: () => void;
  onSidebar: () => void;
  onCloseChat: () => void;
  onCloseSidebar: () => void;
}): JSX.Element | null {
  const sidebarOpen = sidebar?.open ?? false;
  const showLeft = Boolean(sidebar) && !chatOpen;
  const showRight = chatAvailable && !sidebarOpen;
  if (!showLeft && !showRight) return null;
  const buttonClassName =
    "inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/40 bg-card/80 text-muted shadow-sm backdrop-blur transition-colors hover:text-txt";

  return (
    <div
      className="grid shrink-0 grid-cols-[1fr_1fr] items-center border-b border-border/35 bg-bg/92 px-2 py-1.5"
      data-testid="app-workspace-mobile-pane-switcher"
    >
      <div className="flex min-w-0 items-center justify-start">
        {showLeft ? (
          <button
            type="button"
            aria-label={sidebarOpen ? "Hide left sidebar" : "Show left sidebar"}
            aria-pressed={sidebarOpen}
            title={sidebarOpen ? "Hide left sidebar" : "Show left sidebar"}
            data-testid="app-workspace-mobile-pane-left"
            onClick={sidebarOpen ? onCloseSidebar : onSidebar}
            className={buttonClassName}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            ) : (
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-end">
        {showRight ? (
          <button
            type="button"
            aria-label={chatOpen ? "Hide page chat" : "Show page chat"}
            aria-pressed={chatOpen}
            title={chatOpen ? "Hide page chat" : "Show page chat"}
            data-testid="app-workspace-mobile-pane-chat"
            onClick={chatOpen ? onCloseChat : onChat}
            className={buttonClassName}
          >
            {chatOpen ? (
              <PanelRightClose className="h-4 w-4" aria-hidden />
            ) : (
              <PanelRightOpen className="h-4 w-4" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
    </div>
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
  pageScopedChatPaneProps?: Omit<
    PageScopedChatPaneProps,
    "scope" | "footerActions"
  >;
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
  /** Disable the right chat rail for focused surfaces that own their own chat. */
  chatDisabled?: boolean;
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
  chatDisabled = false,
  testId = "app-workspace-chrome",
}: AppWorkspaceChromeProps): JSX.Element {
  const isControlled = chatCollapsedProp !== undefined;
  const isMobileViewport = useMediaQuery(WORKSPACE_MOBILE_MEDIA_QUERY);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileSidebarControl, setMobileSidebarControl] =
    useState<WorkspaceMobileSidebarControl | null>(null);

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
  // Controlled mode is the source of truth on every viewport — including
  // mobile. When the page passes chatCollapsed=true (e.g. forcing a
  // single canonical compose surface in an empty state), the mobile
  // pane-switcher must respect that and not flip back to open via local
  // mobileChatOpen state.
  const effectiveCollapsed = chatDisabled
    ? true
    : isControlled
      ? collapsed
      : isMobileViewport
        ? !mobileChatOpen
        : collapsed;

  const handleToggle = useCallback(
    (next: boolean) => {
      if (isMobileViewport) {
        mobileSidebarControl?.setOpen(false);
        if (isControlled) {
          // Page is the source of truth on mobile too — defer to it
          // instead of touching local mobileChatOpen state.
          onToggleChat?.(next);
          return;
        }
        setMobileChatOpen(chatDisabled ? false : !next);
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
    [
      chatDisabled,
      isControlled,
      isMobileViewport,
      mobileSidebarControl,
      onToggleChat,
    ],
  );

  const registerMobileSidebar = useCallback<
    WorkspaceMobileSidebarControls["register"]
  >((control) => {
    setMobileSidebarControl(control);
    return () => {
      setMobileSidebarControl((current) =>
        current?.id === control.id ? null : current,
      );
    };
  }, []);

  const mobileSidebarControlsValue = useMemo<WorkspaceMobileSidebarControls>(
    () => ({
      register: registerMobileSidebar,
    }),
    [registerMobileSidebar],
  );

  const handleOpenMobileSidebar = useCallback(() => {
    if (!mobileSidebarControl) return;
    setMobileChatOpen(false);
    if (isControlled) {
      onToggleChat?.(true);
    }
    mobileSidebarControl.setOpen(true);
  }, [isControlled, mobileSidebarControl, onToggleChat]);

  const handleCloseMobileSidebar = useCallback(() => {
    mobileSidebarControl?.setOpen(false);
  }, [mobileSidebarControl]);

  const handleCloseMobileChat = useCallback(() => {
    handleToggle(true);
  }, [handleToggle]);

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

  const chatChromeContextValue = useMemo<AppWorkspaceChatChromeContextValue>(
    () => ({
      collapseChat: () => handleToggle(true),
      openChat: () => handleToggle(false),
      isChatOpen: !effectiveCollapsed,
    }),
    [effectiveCollapsed, handleToggle],
  );

  const chatContent =
    chat ??
    (chatScope ? (
      <PageScopedChatPane {...pageScopedChatPaneProps} scope={chatScope} />
    ) : (
      <ChatView variant="default" />
    ));

  return (
    <WorkspaceMobileSidebarControlsContext.Provider
      value={mobileSidebarControlsValue}
    >
      <AppWorkspaceChatChromeContext.Provider value={chatChromeContextValue}>
        <div
          className={`flex min-h-0 min-w-0 w-full flex-1 bg-bg pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))] ${
            isMobileViewport ? "flex-col" : ""
          }`}
          data-testid={testId}
        >
          {isMobileViewport &&
          (!chatDisabled || mobileSidebarControl !== null) ? (
            <MobileWorkspacePaneSwitcher
              chatAvailable={!chatDisabled}
              chatOpen={!effectiveCollapsed}
              sidebar={mobileSidebarControl}
              onChat={() => handleToggle(false)}
              onCloseChat={handleCloseMobileChat}
              onSidebar={handleOpenMobileSidebar}
              onCloseSidebar={handleCloseMobileSidebar}
            />
          ) : null}

          <div
            className={`relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
              isMobileViewport && !effectiveCollapsed ? "hidden" : "flex"
            }`}
          >
            {nav}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              {main}
            </div>
          </div>

          {chatDisabled ? null : effectiveCollapsed ? (
            <aside
              className="w-0 min-w-0 shrink-0"
              data-testid={`${testId}-chat-sidebar`}
              data-collapsed
            >
              {!isMobileViewport ? (
                <AppWorkspaceChatDockToggleButton
                  collapsed
                  testId={`${testId}-chat-expand`}
                />
              ) : null}
            </aside>
          ) : (
            <>
              {isMobileViewport ? (
                <aside
                  className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-bg"
                  data-testid={`${testId}-chat-sidebar`}
                >
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {chatContent}
                  </div>
                </aside>
              ) : null}
              {!isMobileViewport ? (
                <aside
                  className="relative flex shrink-0 flex-col overflow-hidden bg-bg"
                  style={{
                    width: `${chatWidth}px`,
                    minWidth: `${chatWidth}px`,
                  }}
                  data-testid={`${testId}-chat-sidebar`}
                >
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
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {chatContent}
                  </div>
                </aside>
              ) : null}
              {!isMobileViewport && !hideCollapseButton ? (
                <AppWorkspaceChatDockToggleButton
                  collapsed={false}
                  testId={`${testId}-chat-collapse`}
                />
              ) : null}
            </>
          )}
        </div>
      </AppWorkspaceChatChromeContext.Provider>
    </WorkspaceMobileSidebarControlsContext.Provider>
  );
}

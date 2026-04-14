import * as React from "react";
import { cn } from "../../lib/utils";

export type ChatPanelLayoutVariant = "full-overlay" | "companion-dock";

export interface ChatPanelLayoutProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: ChatPanelLayoutVariant;
  sidebar?: React.ReactNode;
  mobileSidebar?: React.ReactNode;
  showSidebar?: boolean;
  thread: React.ReactNode;
}

const CHAT_PANEL_FULL_OVERLAY_CLASSNAME =
  "absolute inset-[max(1rem,6vh)_max(0.75rem,6vw)] z-[100] flex flex-col";
const CHAT_PANEL_DOCK_WRAPPER_CLASSNAME =
  "absolute inset-0 z-10 flex flex-col bg-transparent pb-2 pt-2 sm:pb-4 sm:pt-4";
const CHAT_PANEL_SHELL_BASE_CLASSNAME =
  "relative flex min-h-0 flex-1 flex-col rounded-3xl border border-border/60 shadow-[0_28px_90px_rgba(3,5,10,0.45)] ring-1 ring-white/5";
const CHAT_PANEL_FULL_OVERLAY_SHELL_CLASSNAME = `${CHAT_PANEL_SHELL_BASE_CLASSNAME} overflow-hidden bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_86%,transparent))] backdrop-blur-xl`;
const CHAT_PANEL_DOCK_SHELL_CLASSNAME =
  "relative flex min-h-0 flex-1 flex-col overflow-visible rounded-3xl bg-transparent pointer-events-none";
const CHAT_PANEL_SIDEBAR_SLOT_CLASSNAME = "w-[292px] shrink-0 xl:w-[320px]";
const CHAT_PANEL_THREAD_BASE_CLASSNAME =
  "flex-1 flex flex-col min-w-0 bg-transparent relative";
const CHAT_PANEL_MEDIA_QUERY = "(max-width: 768px)";

function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = React.useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQuery.matches);
    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [query]);

  return matches;
}

export function ChatPanelLayout({
  variant = "full-overlay",
  sidebar,
  mobileSidebar,
  showSidebar = false,
  thread,
  className,
  ...props
}: ChatPanelLayoutProps) {
  const isCompanionDock = variant === "companion-dock";
  const isNarrow = useMatchMedia(CHAT_PANEL_MEDIA_QUERY);
  const showMobileSidebar = isCompanionDock && showSidebar && isNarrow;
  const showDesktopSidebar = !isCompanionDock || (showSidebar && !isNarrow);

  return (
    <div
      className={cn(
        isCompanionDock
          ? CHAT_PANEL_DOCK_WRAPPER_CLASSNAME
          : CHAT_PANEL_FULL_OVERLAY_CLASSNAME,
        className,
      )}
      data-chat-game-overlay={!isCompanionDock || undefined}
      data-chat-game-dock={isCompanionDock || undefined}
      {...props}
    >
      <div
        className={
          isCompanionDock
            ? CHAT_PANEL_DOCK_SHELL_CLASSNAME
            : CHAT_PANEL_FULL_OVERLAY_SHELL_CLASSNAME
        }
        data-chat-game-shell
      >
        {showMobileSidebar ? mobileSidebar : null}
        <div className="flex-1 flex min-h-0">
          {sidebar ? (
            <aside
              className={cn(
                CHAT_PANEL_SIDEBAR_SLOT_CLASSNAME,
                showDesktopSidebar ? "hidden md:flex" : "hidden",
                isCompanionDock && "pointer-events-auto",
              )}
              data-chat-game-sidebar
            >
              {sidebar}
            </aside>
          ) : null}
          <section
            className={cn(
              CHAT_PANEL_THREAD_BASE_CLASSNAME,
              isCompanionDock
                ? "overflow-visible pointer-events-auto"
                : "overflow-hidden",
            )}
            data-chat-game-thread
          >
            {thread}
          </section>
        </div>
      </div>
    </div>
  );
}

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
  const isNarrow = useMatchMedia("(max-width: 768px)");
  const showMobileSidebar = isCompanionDock && showSidebar && isNarrow;
  const showDesktopSidebar = !isCompanionDock || (showSidebar && !isNarrow);

  return (
    <div
      className={cn(
        isCompanionDock
          ? "absolute inset-0 z-10 flex flex-col bg-transparent pb-2 pt-2 sm:pb-4 sm:pt-4"
          : "absolute inset-[max(1rem,6vh)_max(0.75rem,6vw)] z-[100] flex flex-col",
        className,
      )}
      data-chat-game-overlay={!isCompanionDock || undefined}
      data-chat-game-dock={isCompanionDock || undefined}
      {...props}
    >
      <div
        className={
          isCompanionDock
            ? "relative flex min-h-0 flex-1 flex-col overflow-visible rounded-sm bg-transparent pointer-events-none"
            : "relative flex min-h-0 flex-1 flex-col rounded-sm border border-border shadow-sm overflow-hidden bg-card"
        }
        data-chat-game-shell
      >
        {showMobileSidebar ? mobileSidebar : null}
        <div className="flex-1 flex min-h-0">
          {sidebar ? (
            <aside
              className={cn(
                "w-[292px] shrink-0 xl:w-[320px]",
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
              "flex-1 flex flex-col min-w-0 bg-transparent relative",
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

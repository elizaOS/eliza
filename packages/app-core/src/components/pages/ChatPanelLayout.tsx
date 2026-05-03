import { cn } from "@elizaos/ui";
import * as React from "react";

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
      data-chat-overlay={!isCompanionDock || undefined}
      data-chat-dock={isCompanionDock || undefined}
      {...props}
    >
      <div
        className={
          isCompanionDock
            ? "relative flex min-h-0 flex-1 flex-col overflow-visible rounded-3xl bg-transparent pointer-events-none"
            : "relative flex min-h-0 flex-1 flex-col rounded-3xl border border-border/60 shadow-[0_28px_90px_rgba(3,5,10,0.45)] ring-1 ring-white/5 overflow-hidden bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_86%,transparent))] backdrop-blur-xl"
        }
      >
        {showMobileSidebar ? mobileSidebar : null}
        <div className="flex min-h-0 flex-1">
          {sidebar ? (
            <aside
              className={cn(
                "w-[292px] shrink-0 xl:w-[320px]",
                showDesktopSidebar ? "hidden md:flex" : "hidden",
                isCompanionDock && "pointer-events-auto",
              )}
            >
              {sidebar}
            </aside>
          ) : null}
          <section
            className={cn(
              "relative flex min-w-0 flex-1 flex-col bg-transparent",
              isCompanionDock
                ? "overflow-visible pointer-events-auto"
                : "overflow-hidden",
            )}
          >
            {thread}
          </section>
        </div>
      </div>
    </div>
  );
}

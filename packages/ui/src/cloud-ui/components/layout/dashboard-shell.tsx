"use client";

/**
 * The cloud dashboard shell layout: fixed sidebar plus the scrollable content region.
 */
import type { ReactNode } from "react";

export interface DashboardShellLayoutProps {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}

export function DashboardShellLayout({
  sidebar,
  header,
  children,
}: DashboardShellLayoutProps) {
  return (
    // The shell owns all scrolling: the host app locks document scroll, so the
    // frame is pinned to the viewport and the content region scrolls itself
    // (the sidebar scrolls its own nav list independently).
    <div className="theme-cloud dashboard-theme flex h-dvh w-full overflow-hidden bg-black font-poppins text-white">
      {sidebar}

      <div className="flex h-dvh min-w-0 flex-1 flex-col">
        {header}

        <main
          id="main"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-black p-3 md:p-6"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

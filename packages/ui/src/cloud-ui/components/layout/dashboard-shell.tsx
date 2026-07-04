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
    <div className="theme-cloud dashboard-theme flex min-h-dvh w-full bg-black font-poppins text-white">
      {sidebar}

      <div className="flex min-w-0 flex-1 flex-col">
        {header}

        <main id="main" className="min-w-0 flex-1 bg-black p-3 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

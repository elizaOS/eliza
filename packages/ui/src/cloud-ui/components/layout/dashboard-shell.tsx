"use client";

import type { ReactNode } from "react";
import { ScrollArea } from "../scroll-area";

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
    <div className="theme-cloud dashboard-theme flex h-dvh min-h-dvh w-full overflow-hidden bg-black font-poppins text-white">
      {sidebar}

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2 md:gap-3 md:p-3 md:pl-0">
        {header}

        <ScrollArea className="min-w-0 flex-1 border border-white/14 bg-black">
          <main id="main" className="min-w-0 p-3 md:p-6">
            {children}
          </main>
        </ScrollArea>
      </div>
    </div>
  );
}

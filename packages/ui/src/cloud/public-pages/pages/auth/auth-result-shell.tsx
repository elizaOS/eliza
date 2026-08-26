/**
 * Owns the shared full-page surface and centered card geometry for public
 * authentication result states. Callers retain state-specific content and
 * actions while composing one canonical shell.
 */

import type { ReactNode } from "react";

export interface AuthResultShellProps {
  children: ReactNode;
}

export function AuthResultShell({ children }: AuthResultShellProps) {
  return (
    <main className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
      <div className="relative w-full max-w-md border border-border bg-card p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          {children}
        </div>
      </div>
    </main>
  );
}

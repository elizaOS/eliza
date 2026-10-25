/**
 * Owns the shared full-page surface and centered card geometry for public
 * authentication result states. Callers retain state-specific content and
 * actions while composing one canonical shell.
 */

import type { ReactNode } from "react";
import { Card } from "../../../../components/ui/card";

export interface AuthResultShellProps {
  children: ReactNode;
}

export function AuthResultShell({ children }: AuthResultShellProps) {
  return (
    <Card asChild variant="sandboxFrame">
      <main className="theme-cloud relative flex min-h-[100dvh] items-center justify-center p-4">
        <Card variant="outlinedPadded" className="relative w-full max-w-md p-8">
          <div className="flex flex-col items-center gap-6 text-center">
            {children}
          </div>
        </Card>
      </main>
    </Card>
  );
}

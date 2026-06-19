import type * as React from "react";

import { ShellControllerContext } from "./ShellControllerContext.hooks";
import { useShellController } from "./useShellController";

/**
 * Provides a single {@link useShellController} instance to the shell pill /
 * overlay so shell controls stay in lock-step without double-mounting the
 * controller, which would open two mic captures.
 */
export function ShellControllerProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const controller = useShellController();
  return (
    <ShellControllerContext.Provider value={controller}>
      {children}
    </ShellControllerContext.Provider>
  );
}

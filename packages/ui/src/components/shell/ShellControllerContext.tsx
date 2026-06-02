import * as React from "react";

import { type ShellController, useShellController } from "./useShellController";

const ShellControllerContext = React.createContext<ShellController | null>(
  null,
);

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

/** Returns the shared controller, or `null` outside the provider. */
export function useShellControllerContext(): ShellController | null {
  return React.useContext(ShellControllerContext);
}

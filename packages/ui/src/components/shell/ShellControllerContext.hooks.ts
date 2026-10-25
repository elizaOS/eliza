/** React context + accessor for the shared shell controller (useShellController). */

import * as React from "react";

import type { ShellController } from "./useShellController";

export const ShellControllerContext =
  React.createContext<ShellController | null>(null);

/** Returns the shared controller, or `null` outside the provider. */
export function useShellControllerContext(): ShellController | null {
  return React.useContext(ShellControllerContext);
}

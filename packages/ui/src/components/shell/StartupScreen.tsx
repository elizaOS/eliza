/**
 * Live entry point for the startup splash: resolves the current
 * `StartupShellView` from the startup-shell controller and renders `StartupShell`
 * with it, wiring the retry handler. The stateful counterpart to the pure
 * `StartupShell`, which takes its view as a prop.
 */

import { useStartupShellController } from "../../state/use-startup-shell-controller";
import { StartupShell } from "./StartupShell";
import type { StartupShellView } from "./startup-shell-types";

interface StartupScreenProps {
  /**
   * Keeps a real loading surface painted when another startup gate still owns
   * the app after the coordinator itself has reached its render-ready state.
   */
  readyLoadingFallback?: Extract<StartupShellView, { kind: "loading" }>;
}

export function StartupScreen({ readyLoadingFallback }: StartupScreenProps) {
  const { view, retryStartup } = useStartupShellController();
  const resolvedView =
    view.kind === "none" && readyLoadingFallback ? readyLoadingFallback : view;
  return <StartupShell view={resolvedView} onRetry={retryStartup} />;
}

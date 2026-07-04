/**
 * Live entry point for the startup splash: resolves the current
 * `StartupShellView` from the startup-shell controller and renders `StartupShell`
 * with it, wiring the retry handler. The stateful counterpart to the pure
 * `StartupShell`, which takes its view as a prop.
 */

import { useStartupShellController } from "../../state/use-startup-shell-controller";
import { StartupShell } from "./StartupShell";

export function StartupScreen() {
  const { view, retryStartup } = useStartupShellController();
  return <StartupShell view={view} onRetry={retryStartup} />;
}

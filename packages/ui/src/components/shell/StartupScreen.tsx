import { FirstRunScreen } from "../../first-run/FirstRunScreen";
import { useStartupShellController } from "../../state/use-startup-shell-controller";
import { StartupShell } from "./StartupShell";

export function StartupScreen() {
  const { view, retryStartup } = useStartupShellController();
  return (
    <StartupShell
      view={view}
      firstRun={<FirstRunScreen />}
      onRetry={retryStartup}
    />
  );
}

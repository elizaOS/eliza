import { CompactOnboarding } from "../../first-run/CompactOnboarding";
import { useStartupShellController } from "../../state/use-startup-shell-controller";
import { StartupShell } from "./StartupShell";

export function StartupScreen() {
  const { view, retryStartup } = useStartupShellController();
  return (
    <StartupShell
      view={view}
      firstRun={<CompactOnboarding />}
      onRetry={retryStartup}
    />
  );
}

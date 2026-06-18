import { FirstRunShell } from "../components/shell/FirstRunShell";
import { useRenderGuard } from "../hooks/useRenderGuard";
import { useFirstRunController } from "./use-first-run-controller";

export function FirstRunScreen() {
  useRenderGuard("FirstRunScreen");
  const controller = useFirstRunController();
  return <FirstRunShell {...controller} />;
}

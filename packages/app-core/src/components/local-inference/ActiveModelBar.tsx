import { Button } from "@elizaos/ui";
import type {
  ActiveModelState,
  InstalledModel,
} from "../../api/client-local-inference";

interface ActiveModelBarProps {
  active: ActiveModelState;
  installed: InstalledModel[];
  onUnload: () => void;
  busy: boolean;
}

/**
 * Thin strip above the catalog showing which model is currently loaded
 * (and a quick way to unload it). When nothing is active this is empty
 * so the layout doesn't jump as state changes.
 */
export function ActiveModelBar({
  active,
  installed,
  onUnload,
  busy,
}: ActiveModelBarProps) {
  if (!active.modelId) return null;

  const current = installed.find((m) => m.id === active.modelId);
  const label = current?.displayName ?? active.modelId;

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 flex items-center gap-3 text-sm">
      <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
      <div className="flex-1 min-w-0">
        <span className="font-medium">{label}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {active.status === "loading" && "loading…"}
          {active.status === "ready" && "ready"}
          {active.status === "error" && `error: ${active.error ?? "unknown"}`}
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={onUnload} disabled={busy}>
        Unload
      </Button>
    </div>
  );
}

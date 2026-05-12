import { Button } from "../ui/button";
import type {
  ActiveModelState,
  InstalledModel,
} from "../../api/client-local-inference";
import { displayModelName } from "./hub-utils";

interface ActiveModelBarProps {
  active: ActiveModelState;
  installed: InstalledModel[];
  onUnload: () => void;
  busy: boolean;
}

export function ActiveModelBar({
  active,
  installed,
  onUnload,
  busy,
}: ActiveModelBarProps) {
  if (!active.modelId) return null;

  const current = installed.find((m) => m.id === active.modelId);
  const label = current ? displayModelName(current) : active.modelId;
  const status =
    active.status === "loading"
      ? "loading"
      : active.status === "ready"
        ? "ready"
        : `error: ${active.error ?? "unknown"}`;
  const dotClass =
    active.status === "error"
      ? "bg-danger"
      : active.status === "loading"
        ? "bg-warn"
        : "bg-ok";

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs"
      title={`${label} · ${status}`}
    >
      <span
        className={`inline-flex h-2 w-2 rounded-full ${dotClass}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium">{label}</span>
        <span className="ml-1.5 text-muted">{status}</span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-md px-2 text-xs"
        onClick={onUnload}
        disabled={busy}
      >
        Unload
      </Button>
    </div>
  );
}

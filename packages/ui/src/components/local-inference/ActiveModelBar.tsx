import type {
  ActiveModelState,
  InstalledModel,
} from "../../api/client-local-inference";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
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
  const { t } = useTranslation();
  if (!active.modelId) return null;

  const current = installed.find((m) => m.id === active.modelId);
  const label = current ? displayModelName(current) : active.modelId;
  const status =
    active.status === "loading"
      ? t("activemodelbar.loading", { defaultValue: "loading" })
      : active.status === "ready"
        ? t("activemodelbar.ready", { defaultValue: "ready" })
        : t("activemodelbar.error", {
            error:
              active.error ??
              t("activemodelbar.unknown", {
                defaultValue: "unknown",
              }),
            defaultValue: "error: {{error}}",
          });
  const dotClass =
    active.status === "error"
      ? "bg-danger"
      : active.status === "loading"
        ? "bg-warn"
        : "bg-ok";

  return (
    <div
      className="flex items-center gap-2 rounded-sm border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs"
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
        className="h-7 rounded-sm px-2 text-xs"
        onClick={onUnload}
        disabled={busy}
      >
        {t("activemodelbar.unload", { defaultValue: "Unload" })}
      </Button>
    </div>
  );
}

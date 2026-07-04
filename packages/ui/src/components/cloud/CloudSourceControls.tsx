/**
 * Cloud-source controls: a segmented toggle between using Eliza Cloud and a
 * user-supplied API key (`CloudSourceModeToggle`), and a live Eliza Cloud
 * connection indicator (`CloudConnectionStatus`). Rendered in the config/setup
 * surfaces where a feature can be backed by either the managed cloud or the
 * user's own provider key.
 */
import { CheckCircle2, WifiOff } from "lucide-react";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { ConnectionStatus } from "../ui/connection-status";

export type CloudSourceMode = "cloud" | "own-key";

export function CloudSourceModeToggle({
  mode,
  onChange,
  cloudLabel = "Eliza Cloud",
  ownKeyLabel = "Own API Key",
}: {
  mode: CloudSourceMode;
  onChange: (mode: CloudSourceMode) => void;
  cloudLabel?: string;
  ownKeyLabel?: string;
}) {
  const resolvedCloudLabel = cloudLabel;
  return (
    <div className="inline-flex overflow-hidden rounded-sm bg-bg-muted ">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`rounded-sm px-3 py-1.5 text-xs font-semibold transition-colors ${
          mode === "cloud"
            ? "bg-accent text-accent-fg hover:bg-accent/90 hover:text-accent-fg"
            : "bg-transparent text-muted hover:bg-bg-hover hover:text-txt"
        }`}
        onClick={() => onChange("cloud")}
      >
        {resolvedCloudLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`rounded-sm px-3 py-1.5 text-xs font-semibold transition-colors ${
          mode === "own-key"
            ? "bg-accent text-accent-fg hover:bg-accent/90 hover:text-accent-fg"
            : "bg-transparent text-muted hover:bg-bg-hover hover:text-txt"
        }`}
        onClick={() => onChange("own-key")}
      >
        {ownKeyLabel}
      </Button>
    </div>
  );
}

export function CloudConnectionStatus({
  connected,
  connectedText,
  disconnectedText,
}: {
  connected: boolean;
  connectedText?: string;
  disconnectedText: string;
}) {
  const t = useAppSelector((s) => s.t);
  const resolvedConnectedText = connectedText ?? "Connected to Eliza Cloud";
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-sm border border-border/70 bg-bg-muted/90 px-3 py-2.5"
      role="status"
      aria-live="polite"
    >
      <ConnectionStatus
        state={connected ? "connected" : "disconnected"}
        label={connected ? resolvedConnectedText : disconnectedText}
        className="border-0 bg-transparent px-0 py-0 shadow-none"
      />
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-full border ${
          connected
            ? "border-ok/30 bg-ok-subtle text-ok"
            : "border-warn/35 bg-warn-subtle text-warn"
        }`}
        title={
          connected ? t("common.active") : t("cloudsourcecontrols.Offline")
        }
        role="img"
        aria-label={
          connected ? t("common.active") : t("cloudsourcecontrols.Offline")
        }
      >
        {connected ? (
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
        )}
      </span>
    </div>
  );
}

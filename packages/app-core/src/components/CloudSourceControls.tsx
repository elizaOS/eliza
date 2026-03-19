import { Button } from "@elizaos/ui";
import { useApp } from "../state";

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
    <div className="inline-flex overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-sm">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`first:rounded-l-lg first:rounded-r-none last:rounded-l-none last:rounded-r-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
          mode === "cloud"
            ? "bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent)]/90 hover:text-[var(--accent-foreground)]"
            : "bg-transparent text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        }`}
        onClick={() => onChange("cloud")}
      >
        {resolvedCloudLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`first:rounded-l-lg first:rounded-r-none last:rounded-l-none last:rounded-r-lg border-l border-[var(--border)] px-3 py-1.5 text-xs font-semibold transition-colors ${
          mode === "own-key"
            ? "bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent)]/90 hover:text-[var(--accent-foreground)]"
            : "bg-transparent text-[var(--muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
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
  const { t } = useApp();
  const resolvedConnectedText =
    connectedText ?? "Connected to Eliza Cloud";
  return (
    <div className="flex items-center justify-between py-2.5 px-3 border border-[var(--border)] bg-[var(--bg-muted)]">
      {connected ? (
        <>
          <span className="text-xs text-[var(--text)]">
            {resolvedConnectedText}
          </span>
          <span className="rounded-full border border-green-600 bg-green-600/10 px-1.5 py-0.5 text-[10px] text-[var(--text)]">
            {t("appsview.Active")}
          </span>
        </>
      ) : (
        <>
          <span className="text-xs text-[var(--muted)]">
            {disconnectedText}
          </span>
          <span className="rounded-full border border-[var(--warn)] bg-[var(--warn-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text)]">
            {t("cloudsourcecontrols.Offline")}
          </span>
        </>
      )}
    </div>
  );
}

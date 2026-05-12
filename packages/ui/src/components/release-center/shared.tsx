import { StatusBadge, type StatusVariant } from "../ui/status-badge";
import { useApp } from "../../state";

export function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeReleaseNotesUrl(url?: string | null): string {
  const candidate = url?.trim() || "https://elizaos.ai/releases/";
  try {
    return new URL(candidate).toString();
  } catch {
    return "https://elizaos.ai/releases/";
  }
}

const PILL_TONE_MAP: Record<string, StatusVariant> = {
  good: "success",
  warning: "warning",
  neutral: "muted",
};

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "good" | "warning";
}) {
  return (
    <StatusBadge
      label={label}
      variant={PILL_TONE_MAP[tone] ?? "muted"}
      className="rounded-full px-2.5 py-1 text-xs-tight font-medium normal-case"
    />
  );
}

export function DefinitionRow({
  emptyFallback,
  label,
  value,
}: {
  emptyFallback?: string;
  label: string;
  value: string | number | null | undefined;
}) {
  const { t } = useApp();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-right text-xs text-txt break-all">
        {value ??
          emptyFallback ??
          t("common.unavailable", { defaultValue: "Unavailable" })}
      </div>
    </div>
  );
}

export function partitionDescription(
  partition: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return partition === "persist:default"
    ? t("releasecenter.RendererDefaultSession", {
        defaultValue: "Renderer default session",
      })
    : t("releasecenter.SandboxedReleaseNotesSession", {
        defaultValue: "Sandboxed release notes session",
      });
}

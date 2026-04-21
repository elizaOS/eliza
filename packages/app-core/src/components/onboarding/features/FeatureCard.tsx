import { Button, Spinner } from "@elizaos/ui";

export type FeatureStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

interface FeatureCardProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  status: FeatureStatus;
  enabled: boolean;
  managed?: boolean;
  onToggle: (enabled: boolean) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}

const STATUS_BADGE: Record<
  FeatureStatus,
  { label: string; className: string }
> = {
  disconnected: { label: "", className: "" },
  connecting: { label: "Connecting", className: "bg-warn text-black" },
  connected: { label: "Connected", className: "bg-ok text-white" },
  error: { label: "Error", className: "bg-danger text-white" },
};

export function FeatureCard({
  icon,
  name,
  description,
  status,
  enabled,
  managed,
  onToggle,
  t,
}: FeatureCardProps) {
  const badge = STATUS_BADGE[status];
  const isLoading = status === "connecting";

  return (
    <div
      className={`relative flex items-start gap-3 rounded-lg border-2 px-4 py-3 transition-colors ${
        enabled
          ? "border-black bg-black/5"
          : "border-black/20 bg-white hover:border-black/40"
      }`}
    >
      {/* Icon */}
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-black/10 text-lg">
        {icon}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-black">{name}</p>
          {badge.label && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-3xs font-bold ${badge.className}`}
            >
              {badge.label}
            </span>
          )}
          {managed && !badge.label && (
            <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 text-3xs font-bold text-black/50">
              {t("onboarding.features.managed", { defaultValue: "Managed" })}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-black/60">{description}</p>
      </div>

      {/* Toggle */}
      <div className="shrink-0 self-center">
        {isLoading ? (
          <Spinner className="h-5 w-5 text-black/40" />
        ) : enabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-black/30 text-xs font-semibold text-black/70 hover:bg-black/10"
            onClick={() => onToggle(false)}
          >
            {t("onboarding.features.disable", { defaultValue: "Disable" })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 border-2 border-black bg-black text-[#ffe600] text-xs font-semibold hover:bg-[#ffe600] hover:text-black"
            onClick={() => onToggle(true)}
          >
            {managed
              ? t("onboarding.features.connect", { defaultValue: "Connect" })
              : t("onboarding.features.enable", { defaultValue: "Enable" })}
          </Button>
        )}
      </div>
    </div>
  );
}

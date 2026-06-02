import { useAgentElement } from "@elizaos/ui/agent-surface";

export type DataSourceState = "live" | "partial" | "unwired";

export interface DataSourceDescriptor {
  id: string;
  label: string;
  state: DataSourceState;
}

interface DataSourcesStripProps {
  sources: DataSourceDescriptor[];
  className?: string;
  onSetup?: (sourceId: string) => void;
}

function sourceInitials(label: string): string {
  return label
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function sourceToneClass(state: DataSourceState): string {
  switch (state) {
    case "live":
      return "border-emerald-400/35 bg-emerald-400/14 text-emerald-200";
    case "partial":
      return "border-amber-300/35 bg-amber-300/14 text-amber-200";
    default:
      return "border-border/18 bg-bg/30 text-muted";
  }
}

function DataSourceSetupButton({
  source,
  className,
  initials,
  label,
  onSetup,
}: {
  source: DataSourceDescriptor;
  className: string;
  initials: string;
  label: string;
  onSetup: (sourceId: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-source-${source.id}`,
    role: "button",
    label: `Set up ${source.label}`,
    group: "lifeops-overview",
    status: source.state,
    description: `Connect the ${source.label} data source`,
  });
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={`Set up ${source.label}`}
      onClick={() => onSetup(source.id)}
      className={className}
      data-state={source.state}
      {...agentProps}
    >
      {initials}
    </button>
  );
}

export function DataSourcesStrip({
  sources,
  className = "",
  onSetup,
}: DataSourcesStripProps) {
  if (sources.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap gap-2 ${className}`}
      data-testid="lifeops-data-sources-strip"
    >
      {sources.map((source) => {
        const isClickable = source.state === "unwired" && Boolean(onSetup);
        const baseClasses = `inline-flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-semibold ${sourceToneClass(
          source.state,
        )}`;
        const interactiveClasses = isClickable
          ? " transition-colors hover:border-accent/30 hover:text-accent"
          : "";
        const initials = sourceInitials(source.label) || "?";
        const label = `${source.label}: ${source.state}`;
        if (isClickable && onSetup) {
          return (
            <DataSourceSetupButton
              key={source.id}
              source={source}
              className={`${baseClasses}${interactiveClasses}`}
              initials={initials}
              label={label}
              onSetup={onSetup}
            />
          );
        }
        return (
          <span
            key={source.id}
            role="img"
            title={label}
            aria-label={label}
            className={baseClasses}
            data-state={source.state}
          >
            {initials}
          </span>
        );
      })}
    </div>
  );
}

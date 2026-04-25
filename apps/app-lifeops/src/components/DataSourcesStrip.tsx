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

function dotToneClass(state: DataSourceState): string {
  switch (state) {
    case "live":
      return "bg-emerald-400";
    case "partial":
      return "bg-amber-300";
    default:
      return "bg-muted";
  }
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
        const baseClasses =
          "inline-flex h-7 items-center gap-2 rounded-lg border border-border/12 bg-bg/24 px-2 text-[11px] font-medium text-muted";
        const interactiveClasses = isClickable
          ? " transition-colors hover:border-accent/30 hover:text-accent"
          : "";
        const dotEl = (
          <span
            className={`h-2 w-2 rounded-full ${dotToneClass(source.state)}`}
            aria-hidden
          />
        );
        if (isClickable) {
          return (
            <button
              key={source.id}
              type="button"
              title={source.label}
              onClick={() => onSetup?.(source.id)}
              className={`${baseClasses}${interactiveClasses}`}
              data-state={source.state}
            >
              {dotEl}
              {source.label}
            </button>
          );
        }
        return (
          <span
            key={source.id}
            title={source.label}
            className={baseClasses}
            data-state={source.state}
          >
            {dotEl}
            {source.label}
          </span>
        );
      })}
    </div>
  );
}

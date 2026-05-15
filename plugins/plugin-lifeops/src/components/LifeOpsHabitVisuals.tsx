import type { ReactNode } from "react";

export type LifeOpsBucket = {
  key: string;
  label: string;
  totalSeconds: number;
};

const BUCKET_COLORS = [
  "bg-cyan-400",
  "bg-amber-300",
  "bg-emerald-400",
  "bg-rose-400",
  "bg-blue-400",
  "bg-lime-300",
  "bg-fuchsia-400",
  "bg-orange-300",
];

const DONUT_COLORS = [
  "#22d3ee",
  "#fbbf24",
  "#34d399",
  "#fb7185",
  "#60a5fa",
  "#bef264",
  "#e879f9",
  "#fdba74",
];

export function startOfLocalDayIso(date = new Date()): string {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export function formatDurationSeconds(
  value: number | null | undefined,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  if (value <= 0) {
    return "0m";
  }
  const totalMinutes = Math.round(value / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

export function HabitPanel({
  title,
  icon,
  action,
  className,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={[
        "rounded-lg border border-border/16 bg-card/16 p-4",
        className ?? "",
      ].join(" ")}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-txt">
          <span className="text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
          <span className="truncate">{title}</span>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function MetricTile({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/12 bg-bg/30 p-3">
      <div className="mb-2 text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</div>
      <div className="truncate text-xl font-semibold leading-none text-txt">
        {value}
      </div>
      <div className="mt-1 truncate text-[11px] font-medium text-muted">
        {label}
      </div>
    </div>
  );
}

export function StackedBar({
  items,
  totalSeconds,
}: {
  items: LifeOpsBucket[];
  totalSeconds: number;
}) {
  const total = Math.max(totalSeconds, 1);
  return (
    <div className="flex h-3 overflow-hidden rounded-full bg-bg-muted/40">
      {items.length === 0 ? (
        <div className="h-full w-full bg-bg-muted/60" />
      ) : (
        items.slice(0, BUCKET_COLORS.length).map((item, index) => (
          <div
            key={item.key}
            className={BUCKET_COLORS[index] ?? "bg-muted"}
            style={{
              width: `${Math.max(3, (item.totalSeconds / total) * 100)}%`,
            }}
            title={`${item.label}: ${formatDurationSeconds(item.totalSeconds)}`}
          />
        ))
      )}
    </div>
  );
}

export function BucketBars({
  items,
  totalSeconds,
  emptyLabel = "No data",
  limit = 6,
}: {
  items: LifeOpsBucket[];
  totalSeconds: number;
  emptyLabel?: string;
  limit?: number;
}) {
  const total = Math.max(totalSeconds, 1);
  if (items.length === 0) {
    return <div className="py-4 text-xs text-muted">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-2">
      {items.slice(0, limit).map((item, index) => (
        <div key={item.key} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-medium text-txt/90">
              {item.label}
            </span>
            <span className="shrink-0 tabular-nums text-muted">
              {formatDurationSeconds(item.totalSeconds)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-muted/40">
            <div
              className={BUCKET_COLORS[index % BUCKET_COLORS.length]}
              style={{
                width: `${Math.max(2, (item.totalSeconds / total) * 100)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DonutChart({
  items,
  totalSeconds,
  label,
}: {
  items: LifeOpsBucket[];
  totalSeconds: number;
  label: string;
}) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const total = Math.max(totalSeconds, 1);
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg
        viewBox="0 0 110 110"
        className="h-full w-full -rotate-90"
        role="img"
        aria-label={label}
      >
        <circle
          cx="55"
          cy="55"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="12"
          className="text-bg-muted/50"
        />
        {items.slice(0, DONUT_COLORS.length).map((item, index) => {
          const length = (item.totalSeconds / total) * circumference;
          const strokeDasharray = `${length} ${circumference - length}`;
          const strokeDashoffset = -offset;
          offset += length;
          return (
            <circle
              key={item.key}
              cx="55"
              cy="55"
              r={radius}
              fill="none"
              stroke={DONUT_COLORS[index] ?? "#94a3b8"}
              strokeWidth="12"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="butt"
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="text-lg font-semibold leading-none text-txt">
          {formatDurationSeconds(totalSeconds)}
        </div>
        <div className="mt-1 max-w-20 truncate text-[10px] font-medium uppercase text-muted">
          {label}
        </div>
      </div>
    </div>
  );
}

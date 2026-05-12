import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { DAY_NAMES, TIMEZONES } from "./constants";
import { formatHour } from "./helpers";
import type { TimeWindowConfig } from "./types";

/** Static hour options — avoids array-index-as-key lint errors. */
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: formatHour(i),
}));

export function TimeWindowSection({
  config,
  onChange,
}: {
  config: TimeWindowConfig;
  onChange: (config: TimeWindowConfig) => void;
}) {
  const hours = config.allowedHours[0] ?? { start: 9, end: 17 };

  return (
    <div className="space-y-3">
      {/* Hours — start/end */}
      <div className="flex items-center gap-3">
        <div className="flex-1 space-y-1">
          <Label className="text-xs-tight text-muted">From</Label>
          <select
            value={hours.start}
            onChange={(e) =>
              onChange({
                ...config,
                allowedHours: [
                  { start: Number(e.target.value), end: hours.end },
                ],
              })
            }
            className="w-full h-8 rounded-lg border border-border bg-bg px-2 text-xs text-txt"
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-muted text-xs mt-5">→</span>
        <div className="flex-1 space-y-1">
          <Label className="text-xs-tight text-muted">To</Label>
          <select
            value={hours.end}
            onChange={(e) =>
              onChange({
                ...config,
                allowedHours: [
                  { start: hours.start, end: Number(e.target.value) },
                ],
              })
            }
            className="w-full h-8 rounded-lg border border-border bg-bg px-2 text-xs text-txt"
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Days — compact row */}
      <div className="space-y-1">
        <Label className="text-xs-tight text-muted">Active Days</Label>
        <div className="flex gap-1">
          {DAY_NAMES.map((name, i) => {
            const active = config.allowedDays.includes(i);
            return (
              <Button
                key={name}
                variant={active ? "default" : "outline"}
                size="sm"
                className={`h-7 w-9 text-2xs font-medium p-0 ${
                  active ? "" : "border-border/50 text-muted hover:text-txt"
                }`}
                onClick={() => {
                  const days = active
                    ? config.allowedDays.filter((d) => d !== i)
                    : [...config.allowedDays, i].sort();
                  onChange({ ...config, allowedDays: days });
                }}
              >
                {name}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Timezone */}
      <div className="space-y-1">
        <Label className="text-xs-tight text-muted">Timezone</Label>
        <select
          value={config.timezone ?? "UTC"}
          onChange={(e) => onChange({ ...config, timezone: e.target.value })}
          className="w-full h-8 rounded-lg border border-border bg-bg px-2 text-xs text-txt"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function timeWindowSummary(config: TimeWindowConfig): string {
  const hours = config.allowedHours[0];
  if (!hours) return "No hours set";
  const days = config.allowedDays.length;
  const fmtStart = formatHour(hours.start);
  const fmtEnd = formatHour(hours.end);
  return `${fmtStart}–${fmtEnd} · ${days} days`;
}

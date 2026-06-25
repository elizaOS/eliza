import type * as React from "react";
import { useNow } from "../../hooks/useNow";
import { cn } from "../../lib/utils";

/**
 * The home dashboard's always-on default widgets. They render only when no
 * data-driven home widget has anything to show (the data widgets keep
 * self-hiding per #9143) — so the dashboard is never just the floating chat,
 * but it also never shows empty placeholder cards. These are self-contained:
 * they need only the device clock, no agent/account data, so they work offline
 * and on a fresh install.
 *
 * Rendered via the home `WidgetHost`'s `fallback` slot.
 */

const WEEKDAYS_SHORT = ["S", "M", "T", "W", "T", "F", "S"] as const;
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAY_MS = 86_400_000;

function greeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

export function DefaultHomeWidgets(): React.JSX.Element | null {
  // `useNow` is 0 on first render (deterministic render path — no Date.now in
  // render) then the live clock, ticking each minute. Hold until it's live so
  // we never flash the epoch (1970).
  const now = useNow(60_000);
  if (!now) return null;

  const d = new Date(now);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const hour12 = hours % 12 || 12;
  const ampm = hours < 12 ? "AM" : "PM";
  const time = `${hour12}:${String(minutes).padStart(2, "0")}`;
  const dateLabel = `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

  // The current week (Sunday-start), today highlighted — a glanceable calendar.
  const weekStart = now - d.getDay() * DAY_MS;
  const todayDate = d.getDate();
  const week = Array.from(
    { length: 7 },
    (_, i) => new Date(weekStart + i * DAY_MS),
  );

  return (
    <div data-testid="default-home-widgets" className="flex flex-col gap-3">
      {/* Clock + date */}
      <div className="flex flex-col items-center gap-1 rounded-2xl border border-white/10 bg-black/30 px-6 py-7 text-center backdrop-blur-md">
        <div className="text-[3.25rem] font-semibold leading-none tabular-nums tracking-tight text-white">
          {time}
          <span className="ml-1.5 align-top text-base font-medium text-white/60">
            {ampm}
          </span>
        </div>
        <div className="mt-1 text-sm font-medium text-white/75">
          {dateLabel}
        </div>
        <div className="text-xs text-white/50">{greeting(hours)}</div>
      </div>

      {/* This week */}
      <div className="grid grid-cols-7 gap-1 rounded-2xl border border-white/10 bg-black/30 px-3 py-3 backdrop-blur-md">
        {week.map((day) => {
          const isToday =
            day.getDate() === todayDate && day.getMonth() === d.getMonth();
          return (
            <div
              key={day.getTime()}
              className="flex flex-col items-center gap-1"
            >
              <span className="text-[10px] font-medium uppercase text-white/45">
                {WEEKDAYS_SHORT[day.getDay()]}
              </span>
              <span
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-full text-xs tabular-nums",
                  isToday
                    ? "bg-accent font-bold text-white"
                    : "font-medium text-white/80",
                )}
              >
                {day.getDate()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

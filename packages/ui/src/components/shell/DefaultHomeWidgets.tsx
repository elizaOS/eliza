import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  type LucideIcon,
  Sun,
} from "lucide-react";
import type * as React from "react";
import { useNow } from "../../hooks/useNow";
import { useWeather, type WeatherKind } from "../../hooks/useWeather";
import { cn } from "../../lib/utils";

/**
 * The home dashboard's always-on base widgets: a sized grid with the time and
 * weather as 2×2 neighbours, plus a glanceable week strip. They have no card —
 * white text sits directly on the ambient orange field with a soft shadow for
 * legibility ("background gone" per the home redesign). The time + week need
 * only the device clock (offline-safe); weather fetches current conditions from
 * Open-Meteo + device location (see {@link useWeather}) and degrades gracefully.
 *
 * Always rendered as the base of the home surface — the data-driven WidgetHost
 * cards flow in below it, so the dashboard is never bare.
 */

// White text legibility over the bright orange field, no card behind it.
const FLOAT_SHADOW = "[text-shadow:0_1px_3px_rgba(0,0,0,0.38)]";

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

const WEATHER_ICON: Record<WeatherKind, LucideIcon> = {
  clear: Sun,
  cloudy: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
};

function greeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

/** The weather half of the time/weather pair — a naked 2×2 tile. */
function WeatherTile(): React.JSX.Element {
  const weather = useWeather();
  const Icon = WEATHER_ICON[weather.kind];
  return (
    <div
      data-testid="home-weather"
      data-status={weather.status}
      className={cn(
        "col-span-2 row-span-2 flex aspect-square flex-col items-center justify-center gap-1 text-center text-white",
        FLOAT_SHADOW,
      )}
    >
      {weather.status === "loading" ? (
        <div className="text-sm text-white/70">Loading weather…</div>
      ) : weather.status === "unavailable" ? (
        <>
          <Cloud className="h-8 w-8 text-white/80" aria-hidden />
          <div className="mt-1 text-sm font-medium text-white/85">Weather</div>
          <div className="max-w-[8rem] text-xs text-white/65">
            Enable location to see conditions
          </div>
        </>
      ) : (
        <>
          <Icon className="h-9 w-9 text-white" aria-hidden />
          <div className="text-[2.75rem] font-semibold leading-none tabular-nums tracking-tight">
            {weather.temp}
            <span className="align-top text-lg font-medium text-white/70">
              {weather.unit}
            </span>
          </div>
          <div className="text-sm font-medium text-white/85">
            {weather.condition}
          </div>
          {weather.city ? (
            <div className="max-w-[8.5rem] truncate text-xs text-white/60">
              {weather.city}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
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
    <div
      data-testid="default-home-widgets"
      className="grid grid-cols-4 gap-2.5"
    >
      {/* Time — naked 2×2 tile, white text on the ambient field */}
      <div
        className={cn(
          "col-span-2 row-span-2 flex aspect-square flex-col items-center justify-center gap-1 text-center text-white",
          FLOAT_SHADOW,
        )}
      >
        <div className="text-[3.25rem] font-semibold leading-none tabular-nums tracking-tight">
          {time}
          <span className="ml-1.5 align-top text-base font-medium text-white/70">
            {ampm}
          </span>
        </div>
        <div className="mt-1 text-sm font-medium text-white/85">
          {dateLabel}
        </div>
        <div className="text-xs text-white/65">{greeting(hours)}</div>
      </div>

      {/* Weather — naked 2×2 tile next to the time */}
      <WeatherTile />

      {/* This week — full-width strip, white text, no card */}
      <div className={cn("col-span-4 grid grid-cols-7 gap-1", FLOAT_SHADOW)}>
        {week.map((day) => {
          const isToday =
            day.getDate() === todayDate && day.getMonth() === d.getMonth();
          return (
            <div
              key={day.getTime()}
              className="flex flex-col items-center gap-1"
            >
              <span className="text-[10px] font-medium uppercase text-white/55">
                {WEEKDAYS_SHORT[day.getDay()]}
              </span>
              <span
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-full text-xs tabular-nums",
                  isToday
                    ? "bg-white font-bold text-[#d2691e] [text-shadow:none]"
                    : "font-medium text-white/85",
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

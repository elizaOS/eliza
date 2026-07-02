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
import { useAppSelector } from "../../state";

/**
 * The home dashboard's always-on base widgets: a sized grid with the time and
 * weather as 2×2 neighbours. They have no card — white text sits directly on the
 * ambient orange field with a soft shadow for legibility ("background gone" per
 * the home redesign). The time needs only the device clock (offline-safe);
 * weather fetches current conditions from Open-Meteo + device location (see
 * {@link useWeather}) and degrades gracefully.
 *
 * Always rendered as the base of the home surface — the data-driven WidgetHost
 * cards flow in below it, so the dashboard is never bare.
 */

// White text legibility over the bright orange field, no card behind it.
const FLOAT_SHADOW = "[text-shadow:0_1px_3px_rgba(0,0,0,0.38)]";

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
          <div className="flex items-center justify-center gap-2">
            <div className="text-[2.75rem] font-semibold leading-none tabular-nums tracking-tight">
              {weather.temp}
              <span className="align-top text-lg font-medium text-white/70">
                {weather.unit}
              </span>
            </div>
            <Icon className="h-9 w-9 text-white" aria-hidden />
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
  // The time/date tile is on by default but hideable from Appearance settings
  // (#10706); weather is independent and always shown. Select a strict boolean
  // so the tile hides only when the pref is explicitly set (default: shown).
  const timeHidden = useAppSelector((s) => s.homeTimeWidgetHidden === true);
  // `useNow` is 0 on first render (deterministic render path — no Date.now in
  // render) then the live clock, ticking each minute. Hold until it's live so
  // we never flash the epoch (1970) — but only when the time tile is shown; a
  // hidden clock must not gate the weather tile.
  const now = useNow(60_000);
  // Reserve the time tile's footprint whenever it's shown (not hidden by the
  // user), even on the first render when `now` is still 0 — only the time TEXT
  // waits for the live clock. Returning null on frame 1 popped the whole base
  // grid (incl. weather) in a frame later: a guaranteed layout shift on every
  // home mount.
  const showTime = !timeHidden;
  const timeReady = now > 0;

  const d = new Date(now);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const hour12 = hours % 12 || 12;
  const ampm = hours < 12 ? "AM" : "PM";
  const time = `${hour12}:${String(minutes).padStart(2, "0")}`;
  const dateLabel = `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

  return (
    <div
      data-testid="default-home-widgets"
      className="grid grid-cols-4 gap-2.5"
    >
      {/* Time — naked 2×2 tile, white text on the ambient field */}
      {showTime ? (
        <div
          data-testid="home-time-widget"
          className={cn(
            "col-span-2 row-span-2 flex aspect-square flex-col items-center justify-center gap-1 text-center text-white",
            FLOAT_SHADOW,
          )}
        >
          {/* The tile footprint is reserved immediately; the time text stays
              invisible (not unmounted) until the live clock ticks, so nothing
              reflows when it appears. */}
          <div
            className={cn(
              "flex flex-col items-center gap-1",
              !timeReady && "invisible",
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
        </div>
      ) : null}

      {/* Weather — naked 2×2 tile next to the time */}
      <WeatherTile />
    </div>
  );
}

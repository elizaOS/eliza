/**
 * Declares the default home widgets shown by the launcher dashboard.
 */
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
import {
  prefers24HourClock,
  useWeather,
  type WeatherKind,
} from "../../hooks/useWeather";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";

/**
 * The home dashboard's always-on base widgets: a deterministic 4-column grid
 * with the time and weather as 2×2 neighbours. They have no card — white text
 * sits directly on the ambient orange field with a soft shadow for legibility
 * ("background gone" per the home redesign). The time needs only the device
 * clock (offline-safe); weather fetches current conditions from Open-Meteo +
 * device location (see {@link useWeather}) and degrades gracefully.
 *
 * Always rendered as the base of the home surface — the data-driven WidgetHost
 * cards flow in below it, so the dashboard is never bare.
 */

// White text legibility over the bright orange field, no card behind it. The
// wallpaper is a known field (not a theme surface), so `text-white` + this
// shadow is the intended idiom here rather than themed text tokens.
const FLOAT_SHADOW = "[text-shadow:0_1px_3px_rgba(0,0,0,0.38)]";

/** Locale hour cycle, resolved once at module load (never per render). */
const CLOCK_24H = prefers24HourClock();

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

/**
 * The weather half of the time/weather pair — a naked 2×2 tile that mirrors the
 * time tile's footprint (bottom-aligned so the reading settles against the same
 * baseline band as the greeting, giving the pair a shared horizon).
 */
function WeatherTile(): React.JSX.Element {
  const weather = useWeather();
  const Icon = WEATHER_ICON[weather.kind];
  return (
    <div
      data-testid="home-weather"
      data-status={weather.status}
      className={cn(
        "col-span-2 row-span-2 flex min-w-0 flex-col items-end justify-end text-right text-white",
        FLOAT_SHADOW,
      )}
    >
      {weather.status === "loading" ? (
        <div className="text-sm text-white/70">Loading…</div>
      ) : weather.status === "unavailable" ? (
        // Actionable, not a dead-end: an explicit tap is the ONE place allowed
        // to trigger the OS location prompt (home load never does). (#14345)
        <button
          type="button"
          data-testid="home-weather-enable"
          onClick={() => weather.requestLocation()}
          aria-label="Enable location to show weather"
          className="flex flex-col items-end text-right transition-opacity hover:opacity-80"
        >
          <Cloud className="h-7 w-7 text-white/70" aria-hidden />
          <div className="mt-1.5 text-sm font-medium text-white/80">
            Weather
          </div>
          <div className="mt-0.5 max-w-[11rem] text-xs-tight leading-tight text-white/60">
            Tap to enable location
          </div>
        </button>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Icon className="h-7 w-7 text-accent" aria-hidden />
            <div className="text-4xl font-semibold leading-none tabular-nums tracking-tighter">
              {weather.temp}
              <span className="align-top text-base font-medium text-white/60">
                {weather.unit}
              </span>
            </div>
          </div>
          <div className="mt-1.5 text-sm font-medium text-white/85">
            {weather.condition}
          </div>
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
  // Hour cycle follows the locale (resolved once at module load, not per render
  // — the determinism gate forbids Intl in the render path). 24-hour locales
  // drop the AM/PM suffix entirely (#14345).
  const displayHour = CLOCK_24H ? hours : hours % 12 || 12;
  const ampm = CLOCK_24H ? "" : hours < 12 ? "AM" : "PM";
  const time = `${displayHour}:${String(minutes).padStart(2, "0")}`;
  const dateLabel = `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

  return (
    <div
      data-testid="default-home-widgets"
      className="grid grid-cols-4 items-start gap-x-4 gap-y-2"
    >
      {/* Time, the editorial header. Big, left-aligned, with a tight tracking
          display feel; the date + greeting sit beneath as a quiet stack so the
          hierarchy is unmistakable (hero numeral, supporting line, soft
          greeting). White on the ember field with a legibility shadow.

          Hideable from Appearance settings (#10706): only render when the user
          hasn't hidden the time tile. The tile footprint is reserved immediately;
          the time text stays invisible (not unmounted) until the live clock
          ticks, so nothing reflows when the epoch (1970) resolves. */}
      {showTime ? (
        <div
          data-testid="home-time-widget"
          className={cn(
            "col-span-2 row-span-2 flex min-w-0 flex-col justify-end text-left text-white",
            FLOAT_SHADOW,
          )}
        >
          <div className={cn("flex flex-col", !timeReady && "invisible")}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-6xl font-semibold leading-[0.9] tabular-nums tracking-tighter">
                {time}
              </span>
              {ampm ? (
                <span className="text-base font-semibold uppercase tracking-wide text-white/60">
                  {ampm}
                </span>
              ) : null}
            </div>
            <div className="mt-3 text-base font-medium text-white/85">
              {dateLabel}
            </div>
            <div className="mt-1 text-sm font-medium text-accent/90">
              {greeting(hours)}
            </div>
          </div>
        </div>
      ) : null}

      {/* Weather: a quiet right-aligned cluster, not a competing block. */}
      <WeatherTile />
    </div>
  );
}

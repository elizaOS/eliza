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
import { memo } from "react";
import { useSharedNow } from "../../hooks/useSharedNow";
import {
  prefers24HourClock,
  useWeather,
  type WeatherKind,
} from "../../hooks/useWeather";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { WALLPAPER_FLOAT_SHADOW, WALLPAPER_TEXT } from "./wallpaper-idiom";

/**
 * The home dashboard's always-on base widgets: a deterministic 4-column grid
 * with the time and weather as 2×2 neighbours. They have no card - white text
 * sits directly on the ambient orange field with a soft shadow for legibility
 * ("background gone" per the home redesign). The time needs only the device
 * clock (offline-safe); weather fetches current conditions from Open-Meteo +
 * device location (see {@link useWeather}) and degrades gracefully.
 *
 * Always rendered as the base of the home surface - the data-driven WidgetHost
 * cards flow in below it, so the dashboard is never bare.
 */

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

/**
 * The weather half of the time/weather pair - a naked 2×2 tile that mirrors the
 * time tile's footprint (bottom-aligned so the reading settles against the same
 * baseline band as the date, giving the pair a shared horizon).
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
        WALLPAPER_FLOAT_SHADOW,
      )}
    >
      {weather.status === "loading" ? (
        <div className={cn("text-sm", WALLPAPER_TEXT.secondary)}>Loading…</div>
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
          <Cloud
            className={cn("h-7 w-7", WALLPAPER_TEXT.secondary)}
            aria-hidden
          />
          <div className="mt-1.5 text-sm font-medium text-white/80">
            Weather
          </div>
          <div
            className={cn(
              "mt-0.5 max-w-[11rem] text-xs-tight leading-tight",
              WALLPAPER_TEXT.muted,
            )}
          >
            Tap to enable location
          </div>
        </button>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Icon className="h-7 w-7 text-accent" aria-hidden />
            <div className="text-4xl font-semibold leading-none tabular-nums tracking-tighter">
              {weather.temp}
              <span
                className={cn(
                  "align-top text-base font-medium",
                  WALLPAPER_TEXT.muted,
                )}
              >
                {weather.unit}
              </span>
            </div>
          </div>
          <div
            className={cn("mt-1.5 text-sm font-medium", WALLPAPER_TEXT.primary)}
          >
            {weather.condition}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The clock's live content - the leaf of the binding pattern (spec §C.4) for
 * the home base. It owns the shared, visibility-gated minute ticker so the
 * minute roll re-renders ONLY this clock stack, never the sibling `WeatherTile`
 * or the base grid. (Before: `DefaultHomeWidgets` called `useNow(60s)` at the
 * top, so every minute the whole base grid - clock AND weather tile -
 * re-rendered just to move the minutes digit.)
 *
 * `useSharedNow` is `0` on the first render (deterministic render path - no
 * `Date.now()` in render) then the live clock. The tile footprint is reserved
 * by the parent regardless; this leaf only toggles the text `invisible` until
 * the live clock ticks, so nothing reflows when the epoch (1970) resolves.
 */
const HomeClock = memo(function HomeClock(): React.JSX.Element {
  const now = useSharedNow();
  const timeReady = now > 0;

  const d = new Date(now);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  // Hour cycle follows the locale (resolved once at module load, not per render
  // - the determinism gate forbids Intl in the render path). 24-hour locales
  // drop the AM/PM suffix entirely (#14345).
  const displayHour = CLOCK_24H ? hours : hours % 12 || 12;
  const ampm = CLOCK_24H ? "" : hours < 12 ? "AM" : "PM";
  const time = `${displayHour}:${String(minutes).padStart(2, "0")}`;
  const dateLabel = `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

  return (
    <div className={cn("flex flex-col", !timeReady && "invisible")}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-6xl font-semibold leading-[0.9] tabular-nums tracking-tighter">
          {time}
        </span>
        {ampm ? (
          <span
            className={cn(
              "text-base font-semibold uppercase tracking-wide",
              WALLPAPER_TEXT.muted,
            )}
          >
            {ampm}
          </span>
        ) : null}
      </div>
      <div className={cn("mt-3 text-base font-medium", WALLPAPER_TEXT.primary)}>
        {dateLabel}
      </div>
    </div>
  );
});
HomeClock.displayName = "HomeClock";

export function DefaultHomeWidgets(): React.JSX.Element | null {
  // The time/date tile is on by default but hideable from Appearance settings
  // (#10706); weather is independent and always shown. Select a strict boolean
  // so the tile hides only when the pref is explicitly set (default: shown).
  const timeHidden = useAppSelector((s) => s.homeTimeWidgetHidden === true);
  // No `useNow` at this level (binding pattern, spec §C.4): the minute tick is
  // owned by the `<HomeClock>` leaf, so the tick re-renders the clock text only,
  // not this grid and not the sibling `<WeatherTile>`. The time tile's footprint
  // is reserved immediately whenever it's shown - the leaf holds its own text
  // invisible until the live clock ticks - so nothing reflows on home mount.
  const showTime = !timeHidden;

  return (
    <div
      data-testid="default-home-widgets"
      className="grid grid-cols-4 items-start gap-x-4 gap-y-2"
    >
      {/* Time, the editorial header. Big, left-aligned, with a tight tracking
          display feel; the date sits beneath as a quiet supporting line so the
          hierarchy is unmistakable (hero numeral, supporting line). White on the
          ember field with a legibility shadow.

          Hideable from Appearance settings (#10706): only render when the user
          hasn't hidden the time tile. The tile footprint is reserved immediately;
          the time text stays invisible (not unmounted) until the live clock
          ticks, so nothing reflows when the epoch (1970) resolves. */}
      {showTime ? (
        <div
          data-testid="home-time-widget"
          className={cn(
            "col-span-2 row-span-2 flex min-w-0 flex-col justify-end text-left text-white",
            WALLPAPER_FLOAT_SHADOW,
          )}
        >
          <HomeClock />
        </div>
      ) : null}

      {/* Weather: a quiet right-aligned cluster, not a competing block. */}
      <WeatherTile />
    </div>
  );
}

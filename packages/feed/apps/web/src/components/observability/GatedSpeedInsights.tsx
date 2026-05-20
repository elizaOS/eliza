"use client";

/**
 * Gated Vercel Speed Insights (real-user Web Vitals).
 *
 * **Why not raw `<SpeedInsights />` in the root layout?** A global component reports
 * from essentially every navigation. That inflates RUM cost and dilutes dashboards with
 * admin/settings/builder traffic that is not representative of the core product shell.
 *
 * **Why `beforeSend` instead of mounting only on certain pages?** Once the SDK script
 * is injected it typically stays for the SPA session; conditional mount alone does not
 * guarantee zero events after cross-route navigation. Filtering events keeps behavior
 * predictable and matches how we think about “which URLs matter for perf.”
 *
 * **Why `sampleRate`?** Vercel’s SDK supports client-side sampling. We expose it via
 * `NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE` as **0–100** (percent) because operators
 * reason in percentages, not 0–1 floats.
 *
 * **Why `disabled`?** Minimal / embed layouts (`x-minimal-layout`) are not comparable
 * to the full app (different chrome and assets); skipping avoids biased vitals and cost.
 *
 * @see docs/observability/speed-insights.md — full rationale, env table, roadmap.
 */
import { SpeedInsights } from "@vercel/speed-insights/next";
import { useCallback, useMemo } from "react";

/**
 * Prefix allowlist for URLs whose vitals we keep.
 * **Why a static list in code:** Explicit and reviewable in PRs; env-only lists are easy
 * to mis-type and drop all telemetry silently. Change here + update the doc together.
 */
const TRACKED_ROUTE_PREFIXES = [
  "/feed",
  "/markets",
  "/game",
  "/wallet",
  "/profile",
  "/u/",
  "/post/",
  "/chats",
  "/notifications",
  "/leaderboard",
  "/research",
  "/ticker",
  "/share/",
  "/article/",
  "/comment/",
] as const;

function shouldRecordPathname(pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  for (const prefix of TRACKED_ROUTE_PREFIXES) {
    // Match both `/feed` and `/feed/...` so dynamic segments stay included.
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Reads `NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE` as **0–100** (percent of sessions).
 * **Why default 50:** Balance between catching regressions with enough samples and
 * keeping RUM volume (and cost) bounded under traffic spikes; tune per environment in Vercel.
 * **Why clamp:** Mis-set values must not produce invalid SDK input.
 * @returns Fraction in [0, 1] for Vercel’s `sampleRate` prop.
 */
function parseSampleFractionFromEnvPercent(): number {
  const raw = process.env.NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE;
  if (raw === undefined || raw === "") {
    return 0.5;
  }
  const percent = Number.parseFloat(raw);
  if (!Number.isFinite(percent)) {
    return 0.5;
  }
  const clamped = Math.min(100, Math.max(0, percent));
  return clamped / 100;
}

type VitalEvent = {
  type: "vital";
  url: string;
  route?: string;
};

export function GatedSpeedInsights({
  disabled = false,
}: {
  /** When true, do not mount Speed Insights (e.g. minimal embed layout). */
  disabled?: boolean;
}) {
  const sampleRate = useMemo(() => parseSampleFractionFromEnvPercent(), []);

  const beforeSend = useCallback((event: VitalEvent) => {
    let pathname: string;
    try {
      pathname = new URL(event.url).pathname;
    } catch {
      // Malformed `event.url` should never take down the page; drop the event.
      return false;
    }
    // Returning `false` drops the vital before it is sent — primary RUM cost control per route.
    return shouldRecordPathname(pathname) ? event : false;
  }, []);

  if (disabled) {
    return null;
  }

  return <SpeedInsights beforeSend={beforeSend} sampleRate={sampleRate} />;
}

/**
 * Pure selectors and tone mappers backing the detail-extension surfaces: picks
 * the latest run for an app (newest of `updatedAt`/`startedAt`), formats detail
 * timestamps, and maps run health, viewer attachment, and free-form status text
 * to a `SurfaceTone`. Kept free of JSX so extension logic stays unit-testable.
 */

import type {
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
} from "../../../api";
import type { SelectedAppRun, SurfaceTone } from "./surface";

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function selectLatestRunForApp(
  appName: string,
  runs: AppRunSummary[] | null | undefined,
): SelectedAppRun {
  const matchingRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => run.appName === appName)
    .slice()
    .sort((left, right) => {
      const rightTime = Math.max(
        toTimestamp(right.updatedAt),
        toTimestamp(right.startedAt),
      );
      const leftTime = Math.max(
        toTimestamp(left.updatedAt),
        toTimestamp(left.startedAt),
      );
      return rightTime - leftTime;
    });

  return {
    run: matchingRuns[0] ?? null,
    matchingRuns,
  };
}

export function formatDetailTimestamp(
  value: string | number | null | undefined,
): string {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet verified"
      : date.toLocaleString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet verified"
      : date.toLocaleString();
  }

  return "Not yet verified";
}

export function toneForHealthState(
  state: AppRunHealthState | null | undefined,
): SurfaceTone {
  if (state === "healthy") return "success";
  if (state === "degraded") return "warn";
  if (state === "offline") return "danger";
  return "neutral";
}

export function toneForViewerAttachment(
  attachment: AppRunViewerAttachment | null | undefined,
): SurfaceTone {
  if (attachment === "attached") return "success";
  if (attachment === "detached") return "warn";
  return "neutral";
}

export function toneForStatusText(
  status: string | null | undefined,
): SurfaceTone {
  if (!status) return "neutral";
  const normalized = status.toLowerCase();
  if (normalized.includes("running") || normalized.includes("ready")) {
    return "success";
  }
  if (normalized.includes("warn") || normalized.includes("waiting")) {
    return "warn";
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "danger";
  }
  return "neutral";
}

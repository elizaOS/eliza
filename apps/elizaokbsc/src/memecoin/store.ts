import type { DashboardSnapshot } from "./types";

let latestSnapshot: DashboardSnapshot | null = null;

export function setLatestSnapshot(snapshot: DashboardSnapshot): void {
  latestSnapshot = snapshot;
}

export function getLatestSnapshot(): DashboardSnapshot | null {
  return latestSnapshot;
}

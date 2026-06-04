// Pure LifeOps occurrence helpers split out of LifeOpsPageSections.tsx so that
// file exports only React components and types and stays Fast-Refresh-compatible
// (Vite full-reloads a component file that also exports a plain function).

import type { LifeOpsOccurrenceView } from "../contracts/index.js";

export function occurrenceSortValue(occurrence: LifeOpsOccurrenceView): number {
  const candidates = [
    occurrence.dueAt,
    occurrence.snoozedUntil,
    occurrence.scheduledAt,
    occurrence.relevanceStartAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

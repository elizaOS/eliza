export interface BreakingNewsWorldEvent {
  eventType: string;
  description: string;
  relatedQuestion: number | null;
  pointsToward: string | null;
}

const NEWSWORTHY_WORLD_EVENT_PATTERNS = [
  "announcement",
  "development",
  "scandal",
  "deal",
  "meeting",
  "earnings",
  "news:published",
  "leak",
  "revelation",
  "conflict",
  "merger",
  "acquisition",
  "lawsuit",
  "investigation",
  "probe",
  "breach",
  "hack",
  "sanction",
  "exclusive",
  "resignation",
  "launch",
  "upgrade",
  "partnership",
] as const;

export function isBreakingNewsEvent(event: BreakingNewsWorldEvent): boolean {
  if (event.relatedQuestion !== null) {
    return true;
  }

  const pointsToward = event.pointsToward?.trim() ?? "";
  if (pointsToward !== "") {
    return true;
  }

  const haystack = `${event.eventType} ${event.description} ${pointsToward}`
    .trim()
    .toLowerCase();

  return NEWSWORTHY_WORLD_EVENT_PATTERNS.some((pattern) =>
    haystack.includes(pattern),
  );
}

export function selectSignificantWorldEvents<T extends BreakingNewsWorldEvent>(
  events: readonly T[],
  limit: number,
): T[] {
  return events.filter(isBreakingNewsEvent).slice(0, limit);
}

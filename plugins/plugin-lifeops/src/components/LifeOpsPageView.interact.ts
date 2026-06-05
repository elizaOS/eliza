// View-bundle `interact` capability handler plus the LifeOps TUI client + state
// loader it shares with LifeOpsPageView / LifeOpsTuiView, split out of
// LifeOpsPageView.tsx so that file exports only React components and stays
// Fast-Refresh-compatible (Vite would full-reload a component file that also
// exports a plain function). The view bundle re-exports `interact` via
// ./lifeops-view-bundle.ts.

import { client } from "@elizaos/ui";

type LifeOpsTuiOccurrence = {
  id: string;
  title?: string;
  state?: string;
  dueAt?: string | null;
  scheduledAt?: string | null;
  definitionKind?: string;
  priority?: number;
};

type LifeOpsTuiOverview = {
  summary?: {
    activeOccurrenceCount?: number;
    overdueOccurrenceCount?: number;
    snoozedOccurrenceCount?: number;
    activeReminderCount?: number;
    activeGoalCount?: number;
  };
  occurrences?: LifeOpsTuiOccurrence[];
  owner?: {
    occurrences?: LifeOpsTuiOccurrence[];
    goals?: Array<{ id: string; title?: string; status?: string }>;
    reminders?: Array<{ id: string; title?: string }>;
  };
  agentOps?: {
    occurrences?: LifeOpsTuiOccurrence[];
    goals?: Array<{ id: string; title?: string; status?: string }>;
    reminders?: Array<{ id: string; title?: string }>;
  };
};

type LifeOpsTuiDefinitionRecord = {
  definition?: {
    id: string;
    title?: string;
    kind?: string;
    status?: string;
    priority?: number;
  };
};

export const lifeOpsClient = client as typeof client & {
  getLifeOpsAppState?: () => Promise<{ enabled: boolean }>;
  updateLifeOpsAppState?: (data: {
    enabled: boolean;
  }) => Promise<{ enabled: boolean }>;
  getLifeOpsOverview?: () => Promise<LifeOpsTuiOverview>;
  listLifeOpsDefinitions?: () => Promise<{
    definitions: LifeOpsTuiDefinitionRecord[];
  }>;
  completeLifeOpsOccurrence?: (
    occurrenceId: string,
    data?: Record<string, unknown>,
  ) => Promise<unknown>;
  skipLifeOpsOccurrence?: (occurrenceId: string) => Promise<unknown>;
  snoozeLifeOpsOccurrence?: (
    occurrenceId: string,
    data: { minutes?: number; until?: string },
  ) => Promise<unknown>;
};

export async function loadLifeOpsTuiState() {
  const [appState, overview, definitions] = await Promise.all([
    lifeOpsClient.getLifeOpsAppState?.().catch(() => null) ??
      Promise.resolve(null),
    lifeOpsClient.getLifeOpsOverview?.().catch(() => null) ??
      Promise.resolve(null),
    lifeOpsClient.listLifeOpsDefinitions?.().catch(() => null) ??
      Promise.resolve(null),
  ]);
  return {
    appState,
    overview,
    definitions: definitions?.definitions ?? [],
  };
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-lifeops-state") {
    const state = await loadLifeOpsTuiState();
    const overview = state.overview;
    const occurrences =
      overview?.occurrences ?? overview?.owner?.occurrences ?? [];
    return {
      viewType: "tui",
      appState: state.appState,
      summary: overview?.summary ?? null,
      definitions: state.definitions.slice(
        0,
        typeof params?.limit === "number" ? params.limit : 20,
      ),
      occurrences: occurrences.slice(
        0,
        typeof params?.limit === "number" ? params.limit : 20,
      ),
    };
  }

  if (capability === "terminal-lifeops-enable") {
    const enabled = params?.enabled !== false;
    if (!lifeOpsClient.updateLifeOpsAppState) {
      throw new Error("LifeOps app-state client is unavailable");
    }
    return {
      viewType: "tui",
      appState: await lifeOpsClient.updateLifeOpsAppState({ enabled }),
    };
  }

  if (capability === "terminal-lifeops-complete") {
    const occurrenceId =
      typeof params?.occurrenceId === "string"
        ? params.occurrenceId.trim()
        : "";
    if (!occurrenceId) throw new Error("occurrenceId is required");
    if (!lifeOpsClient.completeLifeOpsOccurrence) {
      throw new Error("LifeOps occurrence client is unavailable");
    }
    return {
      viewType: "tui",
      result: await lifeOpsClient.completeLifeOpsOccurrence(occurrenceId, {}),
    };
  }

  if (capability === "terminal-lifeops-skip") {
    const occurrenceId =
      typeof params?.occurrenceId === "string"
        ? params.occurrenceId.trim()
        : "";
    if (!occurrenceId) throw new Error("occurrenceId is required");
    if (!lifeOpsClient.skipLifeOpsOccurrence) {
      throw new Error("LifeOps occurrence client is unavailable");
    }
    return {
      viewType: "tui",
      result: await lifeOpsClient.skipLifeOpsOccurrence(occurrenceId),
    };
  }

  if (capability === "terminal-lifeops-snooze") {
    const occurrenceId =
      typeof params?.occurrenceId === "string"
        ? params.occurrenceId.trim()
        : "";
    if (!occurrenceId) throw new Error("occurrenceId is required");
    if (!lifeOpsClient.snoozeLifeOpsOccurrence) {
      throw new Error("LifeOps occurrence client is unavailable");
    }
    const minutes = typeof params?.minutes === "number" ? params.minutes : 30;
    return {
      viewType: "tui",
      result: await lifeOpsClient.snoozeLifeOpsOccurrence(occurrenceId, {
        minutes,
      }),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}

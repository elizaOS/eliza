/**
 * GoalsView — the GUI data wrapper for the Goals surface.
 *
 * Data-fetching view over the single read-only goals endpoint served by the
 * personal-assistant routes (PA owns the persistence; this plugin only renders):
 *   GET {base}/api/lifeops/goals
 *
 * The wire payload is `{ goals: LifeOpsGoalRecord[] }`, where each record is
 * `{ goal: LifeOpsGoalDefinition; links: LifeOpsGoalLink[] }`. We flatten each
 * record to a `GoalItem` at the fetch boundary so the rest of the view renders
 * display-only.
 *
 * It owns the fetch state machine (loading / error / ready), the status-filter
 * selection, and the quiet 20s background poll, then renders the one
 * presentational {@link GoalsSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` render the browser DOM
 * surface today while the retained modality contract stays available for future
 * adapters.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTOs below are declared locally to match the JSON shape PA emits
 * (LifeOpsGoalDefinition / LifeOpsGoalLink in @elizaos/shared).
 */

import { client } from "@elizaos/ui/api";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GOAL_STATUSES,
  type GoalItem,
  type GoalReviewState,
  type GoalStatus,
} from "../../types.ts";
import { type GoalsSnapshot, GoalsSpatialView } from "./GoalsSpatialView.tsx";

// ---------------------------------------------------------------------------
// Wire DTOs — local mirror of the JSON shape served by the PA goals route.
// Never import PA / @elizaos/shared goal types here; keep this view's contract
// self-contained and aligned by shape.
// ---------------------------------------------------------------------------

interface GoalDefinitionWire {
  id: string;
  title: string;
  description: string;
  cadence: Record<string, unknown> | null;
  successCriteria: Record<string, unknown>;
  status: string;
  reviewState: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface GoalLinkWire {
  id: string;
  goalId: string;
  linkedType: string;
  linkedId: string;
}

interface GoalRecordWire {
  goal: GoalDefinitionWire;
  links: GoalLinkWire[];
}

interface GoalsWire {
  goals: GoalRecordWire[];
}

// ---------------------------------------------------------------------------
// Fetcher seam — default to a real GET; tests inject an offline fake.
// ---------------------------------------------------------------------------

export interface GoalsFetchers {
  fetchGoals: (signal?: AbortSignal) => Promise<GoalsWire>;
}

/** Goals JSON GET is a short UI read — same 15s family as InboxView / FocusView. */
export const GOALS_VIEW_JSON_TIMEOUT_MS = 15_000;

export async function getGoalsJsonWithFetch<T>(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = GOALS_VIEW_JSON_TIMEOUT_MS,
  callerSignal?: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: "GET",
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  });
  if (!response.ok) {
    throw new Error(`Goals request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function getGoals(signal?: AbortSignal): Promise<GoalsWire> {
  return getGoalsJsonWithFetch<GoalsWire>(
    `${client.getBaseUrl()}/api/lifeops/goals`,
    globalThis.fetch,
    GOALS_VIEW_JSON_TIMEOUT_MS,
    signal,
  );
}

const defaultFetchers: GoalsFetchers = {
  fetchGoals: getGoals,
};

export interface GoalsViewProps {
  /** Test/host injection seam. Defaults to the real `/api/lifeops/goals` GET. */
  fetchers?: GoalsFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display DTO mapping.
// ---------------------------------------------------------------------------

const KNOWN_STATUSES: ReadonlySet<string> = new Set(GOAL_STATUSES);
const KNOWN_REVIEW_STATES: ReadonlySet<string> = new Set([
  "idle",
  "needs_attention",
  "on_track",
  "at_risk",
]);

/** Coerce an unknown wire status to a known one; unknowns settle to "active". */
function toStatus(value: string): GoalStatus {
  return KNOWN_STATUSES.has(value) ? (value as GoalStatus) : "active";
}

/** Coerce an unknown wire review state; unknowns settle to "idle". */
function toReviewState(value: string): GoalReviewState {
  return KNOWN_REVIEW_STATES.has(value) ? (value as GoalReviewState) : "idle";
}

/** The cadence record carries a `kind` discriminator when present. */
function readCadenceKind(
  cadence: Record<string, unknown> | null,
): string | null {
  if (cadence && typeof cadence.kind === "string" && cadence.kind.length > 0) {
    return cadence.kind;
  }
  return null;
}

/**
 * successCriteria is a free-form record. We surface a human-readable target
 * only when it carries one of the conventional fields, otherwise null. Display
 * only — no derivation or math.
 */
function readTarget(criteria: Record<string, unknown>): string | null {
  const candidate =
    criteria.targetText ??
    criteria.target ??
    criteria.summary ??
    criteria.deadline ??
    criteria.dueAt;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  if (typeof candidate === "number") return String(candidate);
  return null;
}

function mapGoal(record: GoalRecordWire): GoalItem {
  const { goal, links } = record;
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description ?? "",
    status: toStatus(goal.status),
    reviewState: toReviewState(goal.reviewState),
    cadenceKind: readCadenceKind(goal.cadence),
    target: readTarget(goal.successCriteria ?? {}),
    linkedCount: links.length,
    updatedAt: goal.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; goals: GoalItem[] };

function requestNewGoal(): void {
  client.sendChatMessage?.("Help me set a goal to head toward this quarter.");
}

export function GoalsView(props: GoalsViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeStatuses, setActiveStatuses] = useState<Set<GoalStatus>>(
    () => new Set<GoalStatus>(),
  );

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;
  const activeLoadRef = useRef<AbortController | null>(null);

  const load = useCallback((background = false) => {
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    if (!background) setState({ kind: "loading" });
    fetchersRef.current
      .fetchGoals(controller.signal)
      .then((wire) => {
        if (controller.signal.aborted) return;
        setState({ kind: "ready", goals: wire.goals.map(mapGoal) });
      })
      // error-policy:J4 foreground failures render an error; background failures preserve last-good state.
      .catch((error: unknown) => {
        if (controller.signal.aborted || background) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not load goals.",
        });
      })
      .finally(() => {
        if (activeLoadRef.current === controller) activeLoadRef.current = null;
      });
  }, []);

  // Initial fetch on mount, then a quiet 20s background poll keeps the list
  // fresh (the view has no store subscription and there is no manual refresh).
  // The poll refetches silently: it never drops to the loading skeleton and a
  // transient poll failure leaves the current data on screen.
  useEffect(() => {
    load();
    const interval = setInterval(() => load(true), 20_000);
    return () => {
      clearInterval(interval);
      activeLoadRef.current?.abort();
    };
  }, [load]);

  const toggleStatus = useCallback((status: GoalStatus) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("filter:")) {
        const raw = action.slice("filter:".length);
        if (KNOWN_STATUSES.has(raw)) toggleStatus(raw as GoalStatus);
        return;
      }
      switch (action) {
        case "retry":
          load();
          return;
        case "new":
          requestNewGoal();
          return;
      }
    },
    [load, toggleStatus],
  );

  const snapshot: GoalsSnapshot = useMemo(() => {
    const activeList = Array.from(activeStatuses);
    if (state.kind === "loading") {
      return { status: "loading", goals: [], activeStatuses: activeList };
    }
    if (state.kind === "error") {
      return {
        status: "error",
        goals: [],
        activeStatuses: activeList,
        error: state.message,
      };
    }
    return { status: "ready", goals: state.goals, activeStatuses: activeList };
  }, [state, activeStatuses]);

  return <GoalsSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default GoalsView;

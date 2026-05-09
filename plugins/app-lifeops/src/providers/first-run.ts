/**
 * `firstRunProvider` — surfaces the "first-run not yet completed" affordance
 * to the planner. Goes silent the moment first-run is `complete`.
 *
 * Affordance shape (frozen — `wave1-interfaces.md` §4.1):
 *   { kind: "first_run_pending",
 *     oneLine: "...",                  // ≤ 120 chars
 *     suggestedActionKey: "FIRST_RUN",
 *     paths: ["defaults", "customize"] }
 *
 * Position: `-10` so it lands ahead of most context — same convention as
 * `enabled_skills`.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createFirstRunStateStore } from "../lifeops/first-run/state.js";

export interface FirstRunAffordance {
  kind: "first_run_pending";
  oneLine: string;
  suggestedActionKey: "FIRST_RUN";
  paths: ("defaults" | "customize")[];
}

const QUIET_RESULT: ProviderResult = {
  text: "",
  values: { firstRunPending: false },
  data: {},
};

const ONE_LINE_MAX = 120;

function buildOneLine(inProgress: boolean, partialPath?: string): string {
  if (inProgress) {
    const where = partialPath === "customize" ? " (customize)" : "";
    return `First-run is in progress${where}. Resume FIRST_RUN to continue.`.slice(
      0,
      ONE_LINE_MAX,
    );
  }
  return "First-run hasn't run yet. Offer FIRST_RUN with path = defaults or customize.".slice(
    0,
    ONE_LINE_MAX,
  );
}

export const firstRunProvider: Provider = {
  name: "firstRun",
  description:
    "Surfaces the first-run affordance so the planner can offer FIRST_RUN " +
    "(defaults or customize) on a fresh boot. Goes silent once first-run is complete.",
  descriptionCompressed:
    "Pending first-run affordance; quiet after completion.",
  dynamic: true,
  // Run very early so the affordance reaches the planner before any
  // capability provider can claim the turn.
  position: -10,
  cacheScope: "turn",

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return QUIET_RESULT;
    }
    let store: ReturnType<typeof createFirstRunStateStore>;
    try {
      store = createFirstRunStateStore(runtime);
    } catch (error) {
      logger.debug?.(
        "[first-run-provider] state store unavailable:",
        String(error),
      );
      return QUIET_RESULT;
    }

    let record: Awaited<ReturnType<typeof store.read>>;
    try {
      record = await store.read();
    } catch (error) {
      logger.debug?.("[first-run-provider] state read failed:", String(error));
      return QUIET_RESULT;
    }

    if (record.status === "complete") {
      return QUIET_RESULT;
    }

    const inProgress = record.status === "in_progress";
    const oneLine = buildOneLine(inProgress, record.path);
    const affordance: FirstRunAffordance = {
      kind: "first_run_pending",
      oneLine,
      suggestedActionKey: "FIRST_RUN",
      paths: ["defaults", "customize"],
    };
    return {
      text: oneLine,
      values: {
        firstRunPending: true,
        firstRunStatus: record.status,
        firstRunPath: record.path ?? "",
      },
      data: { affordance },
    };
  },
};

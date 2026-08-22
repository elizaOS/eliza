/**
 * `firstRunProvider` — surfaces the pending first-run affordance
 * to the planner. Goes silent the moment first-run is `complete`.
 *
 * Affordance shape (frozen — `wave1-interfaces.md` §4.1):
 *   { kind: "first_run_pending",
 *     oneLine: "...",                  // ≤ 120 chars
 *     suggestedWorkflowKey: "first_run",
 *     paths: ["defaults", "customize"] }
 *
 * Position: `-10` so it lands ahead of most context — same convention as
 * `enabled_skills`.
 */

import { hasOwnerAccess, listLocalAgentBackups } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { ChannelType, logger } from "@elizaos/core";
import { createFirstRunStateStore } from "../lifeops/first-run/state.js";

export interface FirstRunAffordance {
  kind: "first_run_pending";
  oneLine: string;
  suggestedWorkflowKey: "first_run";
  paths: ("defaults" | "customize")[];
  localBackup?: {
    available: boolean;
    count: number;
    latestCreatedAt?: string;
  };
}

const QUIET_RESULT: ProviderResult = {
  text: "",
  values: { firstRunPending: false },
  data: {},
};

const FIRST_RUN_REQUEST_RE =
  /\b(?:first[-\s]?run|first\s+run\s+setup|onboarding|initial\s+(?:setup|configuration)|setup\s+(?:this\s+)?(?:agent|bot|assistant)|configure\s+(?:this\s+)?(?:agent|bot|assistant)|use\s+defaults|customi[sz]e\s+(?:setup|first[-\s]?run))\b/iu;

function buildOneLine(
  inProgress: boolean,
  partialPath: string | undefined,
  localBackupAvailable: boolean,
): string {
  if (inProgress) {
    const where = partialPath === "customize" ? " (customize)" : "";
    return `First-run setup is in progress${where}. Continue the first-run workflow.`;
  }
  if (localBackupAvailable) {
    return "First-run setup hasn't run yet. Ask whether to restore the latest local backup or start fresh.";
  }
  // "never claim it's done" is load-bearing: observed live (#16941), a
  // fresh-boot "set me up with defaults" ask was answered with "You're all
  // set up" while no setup had run, and a "customize my setup" ask was read
  // as devtool config knobs — the line forbids claiming completion and names
  // the real questions so the model walks the actual flow.
  return "First-run setup NOT done — never claim it is. Offer defaults or customize (wake time / name, categories, channel).";
}

function isPrivateFirstRunSurface(message: Memory): boolean {
  const channelType = message.content.channelType;
  return (
    channelType === ChannelType.DM ||
    channelType === ChannelType.VOICE_DM ||
    channelType === ChannelType.SELF ||
    channelType === ChannelType.API
  );
}

function explicitlyRequestsFirstRun(message: Memory): boolean {
  const text =
    typeof message.content.text === "string" ? message.content.text : "";
  return FIRST_RUN_REQUEST_RE.test(text);
}

function shouldSurfaceFirstRun(message: Memory, inProgress: boolean): boolean {
  return (
    inProgress ||
    isPrivateFirstRunSurface(message) ||
    explicitlyRequestsFirstRun(message)
  );
}

export const firstRunProvider: Provider = {
  name: "firstRun",
  description:
    "Surfaces a dynamic first-run setup affordance on a fresh boot. It does not expose a planner action and goes silent once first-run is complete.",
  descriptionCompressed:
    "Pending first-run affordance; quiet after completion.",
  dynamic: true,
  // A dynamic provider with no routing declaration is invisible to the v5
  // planner: composeState's default path skips `dynamic` providers and the
  // planner's provider selection only adds always-on or context-gated names.
  // Observed live (#16941): a fresh-boot "set me up with sensible defaults"
  // turn composed no first-run line, so the planner confidently replied
  // "you're all set" while first-run had never run. Always-on is correct and
  // cheap here — the provider goes quiet the moment first-run completes, and
  // it self-gates on owner access and surface (same shape as
  // `pendingApprovals`).
  alwaysInResponseState: true,
  contexts: ["general", "settings", "system"],
  contextGate: { anyOf: ["general", "settings", "system"] },
  roleGate: { minRole: "OWNER" },
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
      logger.debug(
        "[first-run-provider] state store unavailable:",
        String(error),
      );
      return QUIET_RESULT;
    }

    let record: Awaited<ReturnType<typeof store.read>>;
    try {
      record = await store.read();
    } catch (error) {
      logger.debug("[first-run-provider] state read failed:", String(error));
      return QUIET_RESULT;
    }

    if (record.status === "complete") {
      return QUIET_RESULT;
    }

    const inProgress = record.status === "in_progress";
    if (!shouldSurfaceFirstRun(message, inProgress)) {
      return QUIET_RESULT;
    }

    const localBackups = inProgress
      ? []
      : await listLocalAgentBackups(runtime.agentId).catch((error: unknown) => {
          logger.debug(
            "[first-run-provider] local backup scan failed:",
            String(error),
          );
          return [];
        });
    const latestBackup = localBackups[0];
    const localBackupAvailable = localBackups.length > 0;
    const oneLine = buildOneLine(inProgress, record.path, localBackupAvailable);
    const affordance: FirstRunAffordance = {
      kind: "first_run_pending",
      oneLine,
      suggestedWorkflowKey: "first_run",
      paths: ["defaults", "customize"],
      ...(localBackupAvailable
        ? {
            localBackup: {
              available: true,
              count: localBackups.length,
              ...(latestBackup?.createdAt
                ? { latestCreatedAt: latestBackup.createdAt }
                : {}),
            },
          }
        : {}),
    };
    return {
      text: oneLine,
      values: {
        firstRunPending: true,
        firstRunStatus: record.status,
        firstRunPath: record.path ?? "",
        firstRunLocalBackupAvailable: localBackupAvailable,
        firstRunLocalBackupCount: localBackups.length,
      },
      data: { affordance },
    };
  },
};

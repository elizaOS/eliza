/**
 * `ftuGoalProvider` — surfaces the post-first-run goal-discovery affordance
 * to the planner: once setup is complete but the assistant has not yet
 * learned what the owner primarily wants help with, it injects a compact
 * instruction to discover that conversationally (one natural question woven
 * into the reply — never a survey). Goes silent the moment the
 * `ftu_goal_discovery` evaluator records a goal.
 *
 * Position `-5`: after `firstRun` (`-10`) so the setup affordance always wins
 * the turn while first-run is still pending, but ahead of ordinary context.
 * Private surfaces only (DM / voice DM / self / API) — goal discovery is an
 * owner conversation, not something to raise in a group room.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { ChannelType, logger } from "@elizaos/core";
import { createFirstRunStateStore } from "../lifeops/first-run/state.js";
import { createFtuGoalStateStore } from "../lifeops/ftu-goal/state.js";

export interface FtuGoalAffordance {
  kind: "ftu_goal_discovery_pending";
  oneLine: string;
}

const QUIET_RESULT: ProviderResult = {
  text: "",
  values: { ftuGoalPending: false },
  data: {},
};

const ONE_LINE =
  "You haven't learned what the owner mainly wants your help with. Weave ONE natural, curious question into your reply to discover what they value or want to get done — conversational, never a survey.";

function isPrivateSurface(message: Memory): boolean {
  const channelType = message.content.channelType;
  return (
    channelType === ChannelType.DM ||
    channelType === ChannelType.VOICE_DM ||
    channelType === ChannelType.SELF ||
    channelType === ChannelType.API
  );
}

export const ftuGoalProvider: Provider = {
  name: "ftuGoal",
  description:
    "Surfaces a goal-discovery affordance after first-run completes and before a primary owner goal is known. Silent once the goal is discovered.",
  descriptionCompressed:
    "Post-first-run goal-discovery affordance; quiet once a goal is known.",
  dynamic: true,
  position: -5,
  cacheScope: "turn",

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!isPrivateSurface(message)) {
      return QUIET_RESULT;
    }
    if (!(await hasOwnerAccess(runtime, message))) {
      return QUIET_RESULT;
    }

    let firstRunComplete: boolean;
    let goalPending: boolean;
    try {
      const [firstRun, ftuGoal] = await Promise.all([
        createFirstRunStateStore(runtime).read(),
        createFtuGoalStateStore(runtime).read(),
      ]);
      firstRunComplete = firstRun.status === "complete";
      goalPending = ftuGoal.status === "pending";
    } catch (error) {
      // error-policy:J4 — a broken cache backend must not break the turn; the
      // affordance degrades to silent and the failure stays observable.
      logger.debug("[ftu-goal-provider] state read failed:", String(error));
      return QUIET_RESULT;
    }

    // Discovery only starts once setup is done: while first-run is pending the
    // firstRun provider owns the onboarding turn, and stacking a second ask on
    // top of setup questions would turn onboarding into a survey.
    if (!firstRunComplete || !goalPending) {
      return QUIET_RESULT;
    }

    const affordance: FtuGoalAffordance = {
      kind: "ftu_goal_discovery_pending",
      oneLine: ONE_LINE,
    };
    return {
      text: ONE_LINE,
      values: { ftuGoalPending: true },
      data: { affordance },
    };
  },
};

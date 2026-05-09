/**
 * `FIRST_RUN` action — runs the first-run flow. Three paths:
 *
 *   - `defaults` — the one-question wake-time path. Schedules gm/gn/check-in/
 *     morning-brief stub.
 *   - `customize` — the 5-question path (per `GAP_ASSESSMENT.md` §5.3) with
 *     abandon/resume + Q4 channel-validation (§8.15).
 *   - `replay` — re-run; preserves existing tasks; refreshes facts.
 *
 * Frozen signature (`wave1-interfaces.md` §4.2):
 *   { path: "defaults" | "customize" | "replay";
 *     partialAnswers?: Record<string, unknown> }
 *
 * The action is idempotent: a re-invocation with the same `path` after
 * `complete` short-circuits to the replay path automatically (per
 * `IMPLEMENTATION_PLAN.md` §3.3 "Re-entry: re-invoke first-run defaults
 * after completion → routes to replay").
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  type CustomizePathInput,
  type DefaultsPathInput,
  type FirstRunRunResult,
  FirstRunService,
  type ReplayPathInput,
} from "../lifeops/first-run/service.js";

type FirstRunPath = "defaults" | "customize" | "replay";

interface FirstRunActionInput {
  path: FirstRunPath;
  partialAnswers?: Record<string, unknown>;
}

function asPath(value: unknown): FirstRunPath | null {
  if (value !== "defaults" && value !== "customize" && value !== "replay") {
    return null;
  }
  return value;
}

function asPartial(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function buildDefaultsInput(
  partial: Record<string, unknown>,
): DefaultsPathInput {
  const out: DefaultsPathInput = {};
  if (typeof partial.wakeTime === "string") out.wakeTime = partial.wakeTime;
  if (typeof partial.timezone === "string") out.timezone = partial.timezone;
  if (typeof partial.channel === "string") out.channel = partial.channel;
  return out;
}

function buildCustomizeInput(
  partial: Record<string, unknown>,
): CustomizePathInput {
  const out: CustomizePathInput = {};
  if (typeof partial.preferredName === "string") {
    out.preferredName = partial.preferredName;
  }
  if (typeof partial.timezone === "string") out.timezone = partial.timezone;
  if (
    partial.morningWindow &&
    typeof partial.morningWindow === "object" &&
    !Array.isArray(partial.morningWindow)
  ) {
    out.morningWindow = partial.morningWindow as {
      startLocal: string;
      endLocal: string;
    };
  }
  if (
    partial.eveningWindow &&
    typeof partial.eveningWindow === "object" &&
    !Array.isArray(partial.eveningWindow)
  ) {
    out.eveningWindow = partial.eveningWindow as {
      startLocal: string;
      endLocal: string;
    };
  }
  if (Array.isArray(partial.categories)) {
    out.categories = partial.categories.filter(
      (c): c is string => typeof c === "string",
    );
  }
  if (typeof partial.channel === "string") out.channel = partial.channel;
  if (Array.isArray(partial.relationships)) {
    const relationships: Array<{ name: string; cadenceDays: number }> = [];
    for (const entry of partial.relationships) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string" || typeof e.cadenceDays !== "number") {
        continue;
      }
      relationships.push({ name: e.name, cadenceDays: e.cadenceDays });
    }
    out.relationships = relationships;
  }
  return out;
}

function summarizeResult(result: FirstRunRunResult): {
  text: string;
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = {
    status: result.status,
    record: result.record,
    facts: result.facts,
    scheduledTaskIds: result.scheduledTasks.map((task) => task.taskId),
    warnings: result.warnings,
  };
  if (result.awaitingQuestion) {
    data.awaitingQuestion = result.awaitingQuestion;
  }
  const warningsText =
    result.warnings.length > 0 ? `\nNote: ${result.warnings.join(" ")}` : "";
  return {
    text: `${result.message}${warningsText}`,
    data,
  };
}

export const firstRunAction: Action = {
  name: "FIRST_RUN",
  similes: [
    "RUN_FIRST_RUN",
    "ONBOARDING",
    "ONBOARD_USER",
    "RUN_ONBOARDING",
    "SETUP_DEFAULTS",
    "RUN_SETUP",
    "RESET_SETUP",
  ],
  description:
    "Owner-only. Run the first-run capability with path = defaults | customize | replay. " +
    "Defaults asks one wake-time question and schedules gm / gn / daily check-in / morning brief. " +
    "Customize walks the 5-question set (preferredName, timezone+windows, categories, channel, optional relationships) and seeds a personalized pack. " +
    "Replay re-confirms facts without touching existing tasks.",
  descriptionCompressed:
    "owner first-run: defaults|customize|replay; defaults asks wake time once",
  routingHint:
    "Use when the firstRun provider surfaces an affordance, OR when the user asks to (re)run setup/onboarding. Pick path=defaults for the quick path; path=customize for the question flow.",
  contexts: ["tasks", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  parameters: [
    {
      name: "path",
      description: "defaults | customize | replay",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "partialAnswers",
      description:
        "Optional object carrying answers from prior turns (resume support).",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "set me up with defaults" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "What time do you usually wake up?",
          action: "FIRST_RUN",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "let's customize my setup" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "What should I call you?",
          action: "FIRST_RUN",
        },
      },
    ],
  ] as ActionExample[][],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      const text = "First-run is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as Partial<FirstRunActionInput>;
    let path = asPath(params.path);
    if (!path) {
      const errText =
        "FIRST_RUN requires path = defaults | customize | replay.";
      await callback?.({ text: errText });
      return {
        text: errText,
        success: false,
        data: { error: "INVALID_PATH" },
      };
    }
    const partial = asPartial(params.partialAnswers);

    const service = new FirstRunService(runtime);

    // Re-entry: if user re-invokes "defaults" after completion, route to
    // replay automatically (per IMPLEMENTATION_PLAN §3.3).
    if (path !== "replay") {
      const state = await service.readState();
      if (state.status === "complete") {
        path = "replay";
      }
    }

    let result: FirstRunRunResult;
    if (path === "defaults") {
      result = await service.runDefaultsPath(buildDefaultsInput(partial));
    } else if (path === "customize") {
      result = await service.runCustomizePath(buildCustomizeInput(partial));
    } else {
      result = await service.runReplayPath(
        buildCustomizeInput(partial) as ReplayPathInput,
      );
    }

    const summary = summarizeResult(result);
    await callback?.({ text: summary.text, data: summary.data });
    return {
      text: summary.text,
      success: result.status === "ok" || result.status === "needs_more_input",
      data: summary.data,
    };
  },
};

export type { FirstRunActionInput };

/**
 * `LIFEOPS` action — verbs `pause`, `resume`, `wipe` (per
 * `GAP_ASSESSMENT.md` §8.14).
 *
 *   - `pause` — sets `GlobalPauseStore` for a window. Tasks with
 *     `respectsGlobalPause: true` are skipped during the window;
 *     `respectsGlobalPause: false` (emergency) tasks fire anyway.
 *   - `resume` — clears the pause window.
 *   - `wipe` — destructive. Requires `confirmed: true`; on first invocation
 *     without confirmation, returns the confirmation prompt. On confirmed
 *     invocation, deletes the cached fallback scheduled tasks (and asks the
 *     production runner to delete its lifeops-owned tasks if registered),
 *     clears the pending-prompts store, clears the global pause window,
 *     and resets the first-run state machine.
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
  clearFallbackScheduledTasks,
  FirstRunService,
} from "../lifeops/first-run/service.js";
import { createGlobalPauseStore } from "../lifeops/global-pause/store.js";
import { createPendingPromptsStore } from "../lifeops/pending-prompts/store.js";

type LifeOpsVerb = "pause" | "resume" | "wipe";

interface LifeOpsActionInput {
  verb?: LifeOpsVerb;
  subaction?: LifeOpsVerb;
  startIso?: string;
  endIso?: string;
  reason?: string;
  confirmed?: boolean;
  /** Free-text "wipe" confirmation token per `GAP_ASSESSMENT.md` §8.14. */
  confirmation?: string;
}

function asVerb(input: Partial<LifeOpsActionInput>): LifeOpsVerb | null {
  const candidate = input.verb ?? input.subaction;
  if (candidate === "pause" || candidate === "resume" || candidate === "wipe") {
    return candidate;
  }
  return null;
}

function isValidIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

export const lifeOpsPauseAction: Action = {
  name: "LIFEOPS",
  similes: [
    "PAUSE_LIFEOPS",
    "RESUME_LIFEOPS",
    "WIPE_LIFEOPS",
    "VACATION_MODE",
    "LIFEOPS_PAUSE",
    "LIFEOPS_RESUME",
    "LIFEOPS_WIPE",
  ],
  description:
    "Owner-only. Verbs: pause (vacation mode — skip respectsGlobalPause tasks until endIso or resume), " +
    "resume (clear the pause), wipe (destructive — clear lifeops-owned scheduled tasks, pending prompts, " +
    "global-pause state, and reset first-run; requires confirmed: true).",
  descriptionCompressed:
    "owner LIFEOPS verb: pause|resume|wipe; wipe requires confirmed:true",
  contexts: ["tasks", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  parameters: [
    {
      name: "verb",
      description: "pause | resume | wipe",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "startIso",
      description: "ISO-8601 start. Defaults to now when verb=pause and unset.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "endIso",
      description: "ISO-8601 end (optional — open-ended pause if absent).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Optional reason ('vacation', 'sick', etc).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Required true for verb=wipe. Without it, wipe returns a confirmation prompt.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "confirmation",
      description:
        "Alternative confirmation token — must equal 'wipe' for verb=wipe.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "pause everything for vacation until next Sunday" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Paused. Reminders will resume after the window closes.",
          action: "LIFEOPS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "resume my routines" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Resumed.",
          action: "LIFEOPS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "wipe my lifeops setup" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "This will delete all scheduled tasks and reset facts. Type 'wipe' to confirm.",
          action: "LIFEOPS",
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
      const text = "LIFEOPS verbs are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as Partial<LifeOpsActionInput>;
    const verb = asVerb(params);
    if (!verb) {
      const text = "LIFEOPS requires verb = pause | resume | wipe.";
      await callback?.({ text });
      return { text, success: false, data: { error: "INVALID_VERB" } };
    }

    if (verb === "pause") {
      const startIso = isValidIso(params.startIso)
        ? params.startIso
        : new Date().toISOString();
      const endIso = isValidIso(params.endIso) ? params.endIso : undefined;
      if (endIso !== undefined && Date.parse(endIso) <= Date.parse(startIso)) {
        const text = "Pause endIso must be strictly after startIso.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { error: "INVALID_PAUSE_WINDOW" },
        };
      }
      const reason =
        typeof params.reason === "string" && params.reason.trim().length > 0
          ? params.reason.trim()
          : undefined;
      const store = createGlobalPauseStore(runtime);
      await store.set({
        startIso,
        ...(endIso ? { endIso } : {}),
        ...(reason ? { reason } : {}),
      });
      const text = endIso
        ? `Paused until ${endIso}. Reminders with respectsGlobalPause=true will resume automatically.`
        : "Paused indefinitely. Use LIFEOPS verb=resume to bring routines back.";
      await callback?.({ text, data: { verb, startIso, endIso, reason } });
      return {
        text,
        success: true,
        data: { verb, startIso, endIso, reason },
      };
    }

    if (verb === "resume") {
      const store = createGlobalPauseStore(runtime);
      await store.clear();
      const text = "Resumed. Paused tasks are eligible to fire again.";
      await callback?.({ text, data: { verb } });
      return { text, success: true, data: { verb } };
    }

    // verb === "wipe"
    const confirmed =
      params.confirmed === true ||
      (typeof params.confirmation === "string" &&
        params.confirmation.trim().toLowerCase() === "wipe");
    if (!confirmed) {
      const text =
        "This will delete every lifeops-owned scheduled task, clear pending prompts, lift the pause, and reset first-run. Re-run LIFEOPS verb=wipe with confirmed: true (or confirmation: 'wipe') to proceed.";
      await callback?.({ text, data: { verb, requiresConfirmation: true } });
      return {
        text,
        success: false,
        data: {
          verb,
          requiresConfirmation: true,
          error: "CONFIRMATION_REQUIRED",
        },
      };
    }

    const pendingPrompts = createPendingPromptsStore(runtime);
    await pendingPrompts.clearAll();
    const pause = createGlobalPauseStore(runtime);
    await pause.clear();
    await clearFallbackScheduledTasks(runtime);
    const firstRun = new FirstRunService(runtime);
    await firstRun.resetState();

    const text =
      "Wiped. All lifeops-owned scheduled tasks, pending prompts, pause windows, and first-run state cleared.";
    await callback?.({ text, data: { verb, wiped: true } });
    return { text, success: true, data: { verb, wiped: true } };
  },
};

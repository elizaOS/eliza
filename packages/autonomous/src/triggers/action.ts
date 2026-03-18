import crypto from "node:crypto";
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { parsePositiveInteger } from "../utils/number-parsing";
import {
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "./runtime";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  normalizeTriggerDraft,
} from "./scheduling";

const CREATE_TRIGGER_TASK_ACTION = "CREATE_TRIGGER_TASK";

const CREATE_TRIGGER_KEYWORDS = [
  "create trigger",
  "create a trigger",
  "create task",
  "schedule trigger",
  "schedule task",
  "run every",
  "run at",
  "every hour",
  "every day",
];

interface TriggerExtraction {
  triggerType?: string;
  displayName?: string;
  instructions?: string;
  wakeMode?: string;
  intervalMs?: string;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: string;
}

interface AutonomyServiceLike {
  getAutonomousRoomId?(): UUID;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseTag(
  xml: string,
  tag: keyof TriggerExtraction,
): string | undefined {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = pattern.exec(xml);
  if (!match?.[1]) return undefined;
  const text = normalizeText(match[1]);
  return text.length > 0 ? text : undefined;
}

function parseExtraction(xml: string): TriggerExtraction {
  return {
    triggerType: parseTag(xml, "triggerType"),
    displayName: parseTag(xml, "displayName"),
    instructions: parseTag(xml, "instructions"),
    wakeMode: parseTag(xml, "wakeMode"),
    intervalMs: parseTag(xml, "intervalMs"),
    scheduledAtIso: parseTag(xml, "scheduledAtIso"),
    cronExpression: parseTag(xml, "cronExpression"),
    maxRuns: parseTag(xml, "maxRuns"),
  };
}

function deriveTriggerType(
  extracted: TriggerExtraction,
): "interval" | "once" | "cron" {
  const type = extracted.triggerType?.toLowerCase();
  if (type === "interval" || type === "once" || type === "cron") {
    return type;
  }
  if (extracted.cronExpression) return "cron";
  if (extracted.scheduledAtIso) return "once";
  return "interval";
}

function extractionPrompt(userText: string): string {
  return [
    "Extract trigger details from this request.",
    "Return only XML with these keys:",
    "triggerType, displayName, instructions, wakeMode, intervalMs, scheduledAtIso, cronExpression, maxRuns",
    "Valid triggerType values: interval, once, cron",
    "Valid wakeMode values: inject_now, next_autonomy_cycle",
    "",
    `Request: ${userText}`,
  ].join("\n");
}

function scheduleText(
  summary: ReturnType<typeof taskToTriggerSummary>,
): string {
  if (!summary) return "scheduled";
  if (summary.triggerType === "interval") {
    return `every ${summary.intervalMs ?? 0} ms`;
  }
  if (summary.triggerType === "once") {
    return `once at ${summary.scheduledAtIso ?? "unknown time"}`;
  }
  return `on cron ${summary.cronExpression ?? "* * * * *"}`;
}

export const createTriggerTaskAction: Action = {
  name: CREATE_TRIGGER_TASK_ACTION,
  similes: ["CREATE_TRIGGER", "SCHEDULE_TRIGGER"],
  description:
    "Create an autonomous trigger task that executes interval, once, or cron schedules",
  validate: async (runtime, message) => {
    if (!triggersFeatureEnabled(runtime)) return false;
    const text = message.content.text?.toLowerCase() ?? "";
    if (!text) return false;
    return CREATE_TRIGGER_KEYWORDS.some((keyword) => text.includes(keyword));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const text = normalizeText(message.content.text ?? "");
    if (!text) {
      return {
        success: false,
        text: "Cannot create a trigger from empty text.",
      };
    }

    if (!triggersFeatureEnabled(runtime)) {
      return {
        success: false,
        text: "Triggers are disabled by configuration.",
      };
    }

    try {
      let extraction: TriggerExtraction = {};
      let extractionFailed = false;
      try {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: extractionPrompt(text),
          stopSequences: [],
        });
        extraction = parseExtraction(response);
      } catch (extractionError) {
        extractionFailed = true;
        runtime.logger.warn(
          {
            src: "trigger-action",
            error:
              extractionError instanceof Error
                ? extractionError.message
                : String(extractionError),
          },
          "LLM extraction failed, using fallback defaults from user text",
        );
      }

      const creator = String(message.entityId ?? runtime.agentId);
      const triggerType = deriveTriggerType(extraction);
      const normalized = normalizeTriggerDraft({
        input: {
          displayName:
            extraction.displayName ?? `Trigger: ${text.slice(0, 64)}`,
          instructions: extraction.instructions ?? text,
          triggerType,
          wakeMode:
            extraction.wakeMode === "next_autonomy_cycle"
              ? "next_autonomy_cycle"
              : "inject_now",
          enabled: true,
          createdBy: creator,
          intervalMs: parsePositiveInteger(extraction.intervalMs),
          scheduledAtIso: extraction.scheduledAtIso,
          cronExpression: extraction.cronExpression,
          maxRuns: parsePositiveInteger(extraction.maxRuns),
        },
        fallback: {
          displayName: `Trigger: ${text.slice(0, 64)}`,
          instructions: text,
          triggerType: "interval",
          wakeMode: "inject_now",
          enabled: true,
          createdBy: creator,
        },
      });

      if (!normalized.draft) {
        return {
          success: false,
          text: normalized.error ?? "Invalid trigger request",
        };
      }

      const existingTasks = await listTriggerTasks(runtime);
      const limit = getTriggerLimit(runtime);
      const creatorCount = existingTasks.filter((task) => {
        const trigger = readTriggerConfig(task);
        return trigger?.enabled && trigger.createdBy === creator;
      }).length;
      if (creatorCount >= limit) {
        return {
          success: false,
          text: `Trigger limit reached (${limit} active triggers).`,
        };
      }

      const triggerId = stringToUuid(crypto.randomUUID());
      const triggerConfig = buildTriggerConfig({
        draft: normalized.draft,
        triggerId,
      });

      const duplicate = existingTasks.find((task) => {
        const existingTrigger = readTriggerConfig(task);
        if (!existingTrigger?.enabled) return false;
        if (existingTrigger.dedupeKey && triggerConfig.dedupeKey) {
          return existingTrigger.dedupeKey === triggerConfig.dedupeKey;
        }
        return (
          normalizeText(existingTrigger.instructions).toLowerCase() ===
            normalizeText(triggerConfig.instructions).toLowerCase() &&
          existingTrigger.triggerType === triggerConfig.triggerType &&
          (existingTrigger.wakeMode ?? "inject_now") ===
            (triggerConfig.wakeMode ?? "inject_now") &&
          (existingTrigger.intervalMs ?? 0) ===
            (triggerConfig.intervalMs ?? 0) &&
          (existingTrigger.scheduledAtIso ?? "") ===
            (triggerConfig.scheduledAtIso ?? "") &&
          (existingTrigger.cronExpression ?? "") ===
            (triggerConfig.cronExpression ?? "")
        );
      });
      if (duplicate?.id) {
        const summary = taskToTriggerSummary(duplicate);
        const duplicateText = `Equivalent trigger already exists (${summary?.displayName ?? duplicate.id}).`;
        if (callback) {
          await callback({
            text: duplicateText,
            action: CREATE_TRIGGER_TASK_ACTION,
            metadata: {
              duplicateTaskId: duplicate.id,
            },
          });
        }
        return {
          success: true,
          text: duplicateText,
          data: {
            duplicateTaskId: duplicate.id,
          },
        };
      }

      const metadata = buildTriggerMetadata({
        trigger: triggerConfig,
        nowMs: Date.now(),
      });
      if (!metadata) {
        return {
          success: false,
          text: "Unable to compute trigger schedule.",
        };
      }

      const autonomy = runtime.getService(
        "AUTONOMY",
      ) as AutonomyServiceLike | null;
      const roomId = autonomy?.getAutonomousRoomId?.() ?? message.roomId;

      const createdTaskId = await runtime.createTask({
        name: TRIGGER_TASK_NAME,
        description: triggerConfig.displayName,
        roomId,
        tags: [...TRIGGER_TASK_TAGS],
        metadata,
      });
      const createdTask = await runtime.getTask(createdTaskId);

      const createdSummary = createdTask
        ? taskToTriggerSummary(createdTask)
        : null;
      const fallbackNote = extractionFailed
        ? " (Note: AI extraction failed; trigger was created from your raw text with default settings.)"
        : "";
      const successText = `Created trigger "${triggerConfig.displayName}" ${scheduleText(createdSummary)}.${fallbackNote}`;
      if (callback) {
        await callback({
          text: successText,
          action: CREATE_TRIGGER_TASK_ACTION,
          metadata: {
            triggerId,
            taskId: String(createdTaskId),
            triggerType: triggerConfig.triggerType,
          },
        });
      }

      return {
        success: true,
        text: successText,
        values: {
          triggerId,
          taskId: String(createdTaskId),
        },
        data: {
          triggerId,
          taskId: String(createdTaskId),
          triggerType: triggerConfig.triggerType,
        },
      };
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Failed to create trigger";
      return {
        success: false,
        text: messageText,
      };
    }
  },
};

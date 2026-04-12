import { v4 as uuidv4 } from "uuid";
import {
	buildTriggerTaskMetadata,
	normalizeTriggerIntervalMs,
	parseCronExpression,
	parseScheduledAtIso,
} from "../../services/triggerScheduling";
import {
	TRIGGER_DISPATCH_TASK_NAME,
	TRIGGER_TASK_TAGS,
} from "../../services/triggerWorker";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../types/index";
import type { SchemaRow } from "../../types/state";
import {
	TRIGGER_SCHEMA_VERSION,
	type TriggerConfig,
	type TriggerType,
	type TriggerWakeMode,
} from "../../types/trigger";
import { stringToUuid } from "../../utils";

const CREATE_TASK_KEYWORDS = [
	"create task",
	"create trigger",
	"create a trigger",
	"set a trigger",
	"schedule a trigger",
	"schedule a task",
	"remind me every",
	"run every",
	"run at",
];

const MAX_TRIGGERS_PER_CREATOR = 100;
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

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

const CREATE_TASK_TRIGGER_SCHEMA: SchemaRow[] = [
	{
		field: "triggerType",
		description: "interval, once, or cron",
		required: false,
	},
	{
		field: "displayName",
		description: "Short human-readable name for the trigger",
		required: false,
	},
	{
		field: "instructions",
		description: "What the trigger should do when it runs",
		required: false,
	},
	{
		field: "wakeMode",
		description: "inject_now or next_autonomy_cycle",
		required: false,
	},
	{
		field: "intervalMs",
		description: "Interval in milliseconds for interval triggers",
		required: false,
	},
	{
		field: "scheduledAtIso",
		description: "ISO timestamp for once triggers",
		required: false,
	},
	{
		field: "cronExpression",
		description: "5-field cron expression for cron triggers",
		required: false,
	},
	{
		field: "maxRuns",
		description: "Maximum number of runs if applicable",
		required: false,
	},
];

function recordToTriggerExtraction(
	r: Record<string, unknown> | null,
): TriggerExtraction {
	if (!r) return {};
	const str = (key: string) => {
		const value = r[key];
		if (value == null) return undefined;
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			return String(value);
		}
		return undefined;
	};
	return {
		triggerType: str("triggerType"),
		displayName: str("displayName"),
		instructions: str("instructions"),
		wakeMode: str("wakeMode"),
		intervalMs: str("intervalMs"),
		scheduledAtIso: str("scheduledAtIso"),
		cronExpression: str("cronExpression"),
		maxRuns: str("maxRuns"),
	};
}

function deriveTriggerType(e: TriggerExtraction): TriggerType {
	const t = e.triggerType?.trim().toLowerCase();
	if (t === "interval" || t === "once" || t === "cron") return t;
	if (e.cronExpression?.trim()) return "cron";
	if (e.scheduledAtIso?.trim()) return "once";
	return "interval";
}

function parsePositiveInt(raw: string | undefined): number | undefined {
	if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
	const v = Number(raw.trim());
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

function dedupeHash(input: string): string {
	let h = 5381;
	for (const c of input) h = (h * 33) ^ c.charCodeAt(0);
	return `trigger-${Math.abs(h >>> 0).toString(16)}`;
}

function describeSchedule(t: TriggerConfig): string {
	if (t.triggerType === "interval")
		return `every ${t.intervalMs ?? DEFAULT_INTERVAL_MS}ms`;
	if (t.triggerType === "once") return `once at ${t.scheduledAtIso ?? "?"}`;
	return `cron ${t.cronExpression ?? "* * * * *"}`;
}

const EXTRACTION_PROMPT_PREFIX = [
	"Extract trigger config from the request. Output TOON only.",
	"Keys: triggerType(interval|once|cron), displayName, instructions, wakeMode(inject_now|next_autonomy_cycle), intervalMs, scheduledAtIso, cronExpression, maxRuns",
	"Return only top-level TOON fields for keys that are known.",
	"Default to interval if no schedule is explicit.",
	"",
].join("\n");

function triggersDisabled(runtime: IAgentRuntime): boolean {
	const setting = runtime.getSetting("TRIGGERS_ENABLED");
	if (setting === false || setting === "false" || setting === "0") return true;
	const env =
		typeof process !== "undefined"
			? process.env.ELIZA_TRIGGERS_ENABLED
			: undefined;
	return env === "0" || env === "false";
}

export const createTaskAction: Action = {
	name: "CREATE_TASK",
	similes: ["CREATE_TRIGGER", "SCHEDULE_TRIGGER", "SCHEDULE_TASK"],
	description: "Create an autonomous trigger task (interval, once, or cron)",
	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "create a trigger every 12 hours to summarize open PRs",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Created a trigger that runs every 12 hours and summarizes open PRs.",
					actions: ["CREATE_TASK"],
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!runtime.enableAutonomy) return false;
		const text = message.content.text?.toLowerCase() ?? "";
		return (
			text.length > 0 && CREATE_TASK_KEYWORDS.some((kw) => text.includes(kw))
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		const text = (message.content.text ?? "").trim().replace(/\s+/g, " ");
		if (!text) return { success: false, text: "Empty request." };
		if (!runtime.enableAutonomy)
			return { success: false, text: "Autonomy is disabled." };
		if (triggersDisabled(runtime))
			return { success: false, text: "Triggers are disabled." };

		try {
			const extracted = recordToTriggerExtraction(
				await runtime.promptBatcher.askNow(
					`create-task-trigger-extraction:${uuidv4()}`,
					{
						preamble: `${EXTRACTION_PROMPT_PREFIX}Request: ${text}`,
						schema: CREATE_TASK_TRIGGER_SCHEMA,
						fallback: {},
						model: "small",
						execOptions: {
							stopSequences: [],
						},
					},
				),
			);

			const triggerType = deriveTriggerType(extracted);
			const displayName =
				(extracted.displayName ?? "").trim() || `Trigger: ${text.slice(0, 64)}`;
			const instructions = (extracted.instructions ?? "").trim() || text;
			const wakeMode: TriggerWakeMode =
				extracted.wakeMode?.trim().toLowerCase() === "next_autonomy_cycle"
					? "next_autonomy_cycle"
					: "inject_now";
			const creatorId = String(message.entityId ?? runtime.agentId);
			const intervalMs = normalizeTriggerIntervalMs(
				parsePositiveInt(extracted.intervalMs) ?? DEFAULT_INTERVAL_MS,
			);
			const scheduledAtIso = extracted.scheduledAtIso?.trim();
			const cronExpression = extracted.cronExpression?.trim();
			const maxRuns = parsePositiveInt(extracted.maxRuns);

			if (
				triggerType === "once" &&
				(!scheduledAtIso || parseScheduledAtIso(scheduledAtIso) === null)
			) {
				throw new Error("Once trigger requires a valid scheduledAtIso");
			}
			if (
				triggerType === "cron" &&
				(!cronExpression || !parseCronExpression(cronExpression))
			) {
				throw new Error(
					"Cron trigger requires a valid 5-field cron expression",
				);
			}

			const dedupeKey = dedupeHash(
				`${triggerType}|${instructions.toLowerCase()}|${intervalMs}|${scheduledAtIso ?? ""}|${cronExpression ?? ""}`,
			);

			const existingTasks = await runtime.getTasks({
				tags: [...TRIGGER_TASK_TAGS],
				agentIds: [runtime.agentId],
			});

			if (
				existingTasks.filter(
					(t) =>
						t.metadata?.trigger?.createdBy === creatorId &&
						t.metadata?.trigger?.enabled,
				).length >= MAX_TRIGGERS_PER_CREATOR
			) {
				throw new Error(`Trigger limit reached (${MAX_TRIGGERS_PER_CREATOR})`);
			}

			const duplicate = existingTasks.find((t) => {
				const et = t.metadata?.trigger;
				if (!et?.enabled) return false;
				if (et.dedupeKey) return et.dedupeKey === dedupeKey;
				return (
					et.instructions.trim().toLowerCase() === instructions.toLowerCase() &&
					et.triggerType === triggerType &&
					(et.intervalMs ?? 0) ===
						(triggerType === "interval" ? intervalMs : 0) &&
					(et.scheduledAtIso ?? "") ===
						(triggerType === "once" ? (scheduledAtIso ?? "") : "") &&
					(et.cronExpression ?? "") ===
						(triggerType === "cron" ? (cronExpression ?? "") : "")
				);
			});
			if (duplicate?.id) {
				const msg = "An equivalent trigger already exists.";
				if (callback)
					await callback({
						text: msg,
						action: "CREATE_TASK",
						metadata: { duplicateTaskId: duplicate.id },
					});
				return {
					success: true,
					text: msg,
					data: { duplicateTaskId: duplicate.id, dedupeKey },
				};
			}

			const triggerId = stringToUuid(uuidv4());
			const triggerConfig: TriggerConfig = {
				version: TRIGGER_SCHEMA_VERSION,
				triggerId,
				displayName,
				instructions,
				triggerType,
				enabled: true,
				wakeMode,
				createdBy: creatorId,
				runCount: 0,
				intervalMs: triggerType === "interval" ? intervalMs : undefined,
				scheduledAtIso:
					triggerType === "once" ? (scheduledAtIso as string) : undefined,
				cronExpression:
					triggerType === "cron" ? (cronExpression as string) : undefined,
				maxRuns,
				dedupeKey,
			};

			const metadata = buildTriggerTaskMetadata({
				trigger: triggerConfig,
				nowMs: Date.now(),
			});
			if (!metadata) throw new Error("Failed to compute trigger schedule");

			const autonomyRoomId = (
				runtime.getService("AUTONOMY") as {
					getAutonomousRoomId?(): UUID;
				} | null
			)?.getAutonomousRoomId?.();
			const roomId = autonomyRoomId ?? message.roomId;

			const taskId = await runtime.createTask({
				name: TRIGGER_DISPATCH_TASK_NAME,
				description: displayName,
				roomId,
				tags: [...TRIGGER_TASK_TAGS],
				metadata,
			});

			const msg = `Created trigger "${displayName}" (${describeSchedule(triggerConfig)}).`;
			if (callback)
				await callback({
					text: msg,
					action: "CREATE_TASK",
					metadata: { triggerId, taskId, triggerType, wakeMode },
				});
			return {
				success: true,
				text: msg,
				values: { triggerId, taskId },
				data: { triggerId, taskId, triggerType, wakeMode, dedupeKey },
			};
		} catch (error) {
			const msg =
				error instanceof Error ? error.message : "Failed to create trigger";
			if (callback)
				await callback({
					text: msg,
					action: "CREATE_TASK",
					metadata: { error: msg },
				});
			return { success: false, text: msg };
		}
	},
};

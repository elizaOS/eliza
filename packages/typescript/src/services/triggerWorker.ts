import { v4 as uuidv4 } from "uuid";
import type {
	IAgentRuntime,
	Memory,
	Task,
	TaskMetadata,
	TriggerConfig,
	TriggerRunRecord,
	UUID,
} from "../types";
import { Service } from "../types/service";
import { stringToUuid } from "../utils";
import {
	DISABLED_TRIGGER_INTERVAL_MS,
	resolveTriggerTiming,
} from "./triggerScheduling";

export const TRIGGER_DISPATCH_TASK_NAME = "TRIGGER_DISPATCH" as const;
export const TRIGGER_TASK_TAGS = ["queue", "repeat", "trigger"] as const;
const TRIGGER_RUN_HISTORY_LIMIT = 100;

interface AutonomyServiceLike {
	enableAutonomy?(): Promise<void>;
	getAutonomousRoomId?(): UUID;
	injectAutonomousInstruction?(params: {
		instructions: string;
		source: "trigger_dispatch";
		triggerId: UUID;
		wakeMode: "inject_now" | "next_autonomy_cycle";
		triggerTaskId: UUID;
	}): Promise<void>;
	triggerThinkNow?(): Promise<boolean>;
}

export interface TriggerDispatchExecuteOptions {
	source: "scheduler" | "manual";
	force?: boolean;
}

function appendRunRecord(
	existing: TriggerRunRecord[] | undefined,
	record: TriggerRunRecord,
): TriggerRunRecord[] {
	const runs = [...(existing ?? []), record];
	return runs.length <= TRIGGER_RUN_HISTORY_LIMIT
		? runs
		: runs.slice(runs.length - TRIGGER_RUN_HISTORY_LIMIT);
}

async function dispatchIntoAutonomy(
	runtime: IAgentRuntime,
	taskId: UUID,
	trigger: TriggerConfig,
): Promise<void> {
	const autonomy = runtime.getService("AUTONOMY") as AutonomyServiceLike | null;
	if (!autonomy) {
		throw new Error("Autonomy service is not available");
	}

	if (autonomy.injectAutonomousInstruction) {
		await autonomy.injectAutonomousInstruction({
			instructions: trigger.instructions,
			source: "trigger_dispatch",
			triggerId: trigger.triggerId,
			wakeMode: trigger.wakeMode,
			triggerTaskId: taskId,
		});
		return;
	}

	if (autonomy.enableAutonomy) {
		await autonomy.enableAutonomy();
	}

	const autonomousRoomId = autonomy.getAutonomousRoomId?.();
	if (!autonomousRoomId) {
		throw new Error("Autonomy room is not available");
	}

	const memory: Memory = {
		id: stringToUuid(uuidv4()),
		agentId: runtime.agentId,
		entityId: runtime.agentId,
		roomId: autonomousRoomId,
		createdAt: Date.now(),
		content: {
			text: trigger.instructions,
			source: "trigger-dispatch-worker",
			metadata: {
				type: "autonomous-trigger",
				triggerId: trigger.triggerId,
				wakeMode: trigger.wakeMode,
			},
		},
	};

	await runtime.createMemory(memory, "memories");

	if (trigger.wakeMode === "inject_now" && autonomy.triggerThinkNow) {
		await autonomy.triggerThinkNow();
	}
}

async function persistNextSchedule(params: {
	runtime: IAgentRuntime;
	task: Task;
	trigger: TriggerConfig;
	runRecord: TriggerRunRecord;
}): Promise<void> {
	const { runtime, task, trigger, runRecord } = params;
	if (!task.id) return;

	if (trigger.triggerType === "once") {
		await runtime.deleteTask(task.id);
		return;
	}

	const nextTiming = resolveTriggerTiming(trigger, runRecord.finishedAt);
	let nextTrigger: TriggerConfig = trigger;
	let nextUpdateInterval = DISABLED_TRIGGER_INTERVAL_MS;
	let nextUpdatedAt = runRecord.finishedAt;

	if (nextTiming) {
		nextTrigger = {
			...nextTrigger,
			nextRunAtMs: nextTiming.nextRunAtMs,
		};
		nextUpdateInterval = nextTiming.updateIntervalMs;
		nextUpdatedAt = nextTiming.updatedAt;
	} else {
		nextTrigger = {
			...nextTrigger,
			enabled: false,
			nextRunAtMs: runRecord.finishedAt + DISABLED_TRIGGER_INTERVAL_MS,
			lastStatus: "error",
			lastError:
				nextTrigger.lastError ?? "Unable to compute next trigger schedule",
		};
	}

	const nextMetadata: TaskMetadata = {
		...(task.metadata ?? {}),
		updatedAt: nextUpdatedAt,
		updateInterval: nextUpdateInterval,
		trigger: nextTrigger,
		triggerRuns: appendRunRecord(task.metadata?.triggerRuns, runRecord),
	};

	await runtime.updateTask(task.id, {
		metadata: nextMetadata,
	});
}

export async function executeTriggerDispatch(
	runtime: IAgentRuntime,
	task: Task,
	options: TriggerDispatchExecuteOptions,
): Promise<void> {
	if (!task.id) return;
	const trigger = task.metadata?.trigger;
	if (!trigger) return;

	if (!trigger.enabled && !options.force) {
		return;
	}

	if (
		typeof trigger.maxRuns === "number" &&
		trigger.maxRuns > 0 &&
		trigger.runCount >= trigger.maxRuns
	) {
		await runtime.deleteTask(task.id);
		return;
	}

	const startedAt = Date.now();
	let status: TriggerRunRecord["status"] = "success";
	let errorMessage = "";

	try {
		await dispatchIntoAutonomy(runtime, task.id, trigger);
	} catch (error) {
		status = "error";
		errorMessage = error instanceof Error ? error.message : String(error);
		runtime.logger.error(
			{
				src: "trigger-worker",
				agentId: runtime.agentId,
				taskId: task.id,
				triggerId: trigger.triggerId,
				error: errorMessage,
			},
			"Trigger dispatch failed",
		);
	}

	if (status === "success") {
		runtime.logger.info(
			{
				src: "trigger-worker",
				triggerId: trigger.triggerId,
				triggerName: trigger.displayName,
				source: options.source,
				latencyMs: Date.now() - startedAt,
			},
			`Trigger "${trigger.displayName}" dispatched`,
		);
	}

	const finishedAt = Date.now();
	const nextRunCount = trigger.runCount + 1;
	const runRecord: TriggerRunRecord = {
		triggerRunId: stringToUuid(uuidv4()),
		triggerId: trigger.triggerId,
		taskId: task.id,
		startedAt,
		finishedAt,
		status,
		error: errorMessage || undefined,
		latencyMs: finishedAt - startedAt,
		source: options.source,
	};

	const updatedTrigger: TriggerConfig = {
		...trigger,
		runCount: nextRunCount,
		lastRunAtIso: new Date(finishedAt).toISOString(),
		lastStatus: status,
		lastError: errorMessage || undefined,
	};

	if (
		typeof updatedTrigger.maxRuns === "number" &&
		updatedTrigger.maxRuns > 0 &&
		updatedTrigger.runCount >= updatedTrigger.maxRuns
	) {
		await runtime.deleteTask(task.id);
		return;
	}

	await persistNextSchedule({
		runtime,
		task,
		trigger: updatedTrigger,
		runRecord,
	});
}

export function registerTriggerDispatchWorker(runtime: IAgentRuntime): void {
	if (runtime.getTaskWorker(TRIGGER_DISPATCH_TASK_NAME)) return;

	runtime.registerTaskWorker({
		name: TRIGGER_DISPATCH_TASK_NAME,
		shouldRun: async () => true,
		execute: async (rt, options, task) => {
			await executeTriggerDispatch(rt, task, {
				source: options.source === "manual" ? "manual" : "scheduler",
				force: options.force === true,
			});
			return undefined;
		},
	});
}

export class TriggerDispatchService extends Service {
	static serviceType = "trigger_dispatch" as const;
	capabilityDescription = "Dispatches trigger tasks into the autonomy loop";

	static async start(runtime: IAgentRuntime): Promise<Service> {
		registerTriggerDispatchWorker(runtime);
		return new TriggerDispatchService(runtime);
	}

	async stop(): Promise<void> {}
}

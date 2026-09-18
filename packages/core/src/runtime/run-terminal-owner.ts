/** Single terminal-event owner for a runtime run and its asynchronous work. */

import { ElizaError } from "../errors";
import {
	roomDeliverySettlement,
	trackPostDeliveryTask,
} from "../services/post-delivery-task-tracker";
import type {
	ActionResult,
	EffectReceipt,
	IAgentRuntime,
	Memory,
	RunEventPayload,
	UUID,
} from "../types";
import { mergeEffectReceipts } from "../types/effects";
import { EventType } from "../types/events";
import type { TurnOutcome } from "../types/message-service";
import type { RoomHandlerLease } from "./room-handler-queue";

/**
 * Owns asynchronous continuations whose provider, model, or database-trajectory
 * captures belong to one message-service run. Delivery returns as soon as the
 * visible result is ready; the detached terminal waits for this set to quiesce,
 * then emits exactly one `RUN_ENDED` event. File-recorder finalization and
 * bounded inference-timing persistence are diagnostic-only and intentionally
 * drain independently. A run-owned task may not join after terminalization is
 * requested.
 */
export class RunTerminalOwner {
	private readonly pending = new Set<Promise<void>>();
	private settledEffects: readonly EffectReceipt[] = [];

	/** Capture handler settlement before host callbacks or reply generation can fail. */
	recordActionResult(result: ActionResult): void {
		this.settledEffects = mergeEffectReceipts(
			this.settledEffects,
			result.effectReceipts,
		);
	}

	get effects(): readonly EffectReceipt[] {
		return this.settledEffects;
	}

	private terminalRequest:
		| {
				outcome: TurnOutcome;
				error?: unknown;
		  }
		| undefined;
	private terminalTask: Promise<void> | undefined;

	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly runId: UUID,
		private readonly message: Memory,
		private readonly startTime: number,
		private readonly roomHandlerLease?: RoomHandlerLease,
	) {}

	track(label: string, task: () => Promise<unknown>): Promise<void> {
		if (this.terminalRequest) {
			const error = new ElizaError(
				"Run-owned work cannot start after terminalization was requested",
				{
					code: "RUN_TASK_AFTER_TERMINAL",
					context: {
						label,
						runId: this.runId,
						messageId: this.message.id,
					},
				},
			);
			this.runtime.reportError("RunTerminalOwner.track", error, {
				label,
				runId: this.runId,
				messageId: this.message.id,
			});
			return Promise.resolve();
		}

		let tracked!: Promise<void>;
		tracked = Promise.resolve()
			.then(task)
			.then(() => undefined)
			.catch((error) => {
				// error-policy:J1 User delivery is already committed. Preserve the exact
				// child failure while allowing the terminal barrier to release the run.
				this.runtime.reportError("PostDeliveryTask", error, {
					agentId: this.runtime.agentId,
					label,
					runId: this.runId,
				});
			})
			.finally(() => {
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
		return tracked;
	}

	adopt(label: string, task: Promise<unknown>): Promise<void> {
		return this.track(label, () => task);
	}

	/** Evidence extraction must observe the connector's settled persisted reply,
	 * including delivery receipts/callback history, not its provisional row. */
	trackAfterDelivery(
		label: string,
		task: () => Promise<unknown>,
	): Promise<void> {
		const delivered = roomDeliverySettlement(
			this.runtime,
			this.message.roomId,
			this.roomHandlerLease,
		);
		return this.track(label, async () => {
			if (!(await delivered))
				throw new ElizaError(
					"Post-turn work skipped because delivery did not settle",
					{
						code: "POST_DELIVERY_NOT_SETTLED",
					},
				);
			return task();
		});
	}

	request(outcome: TurnOutcome, error?: unknown): Promise<void> {
		if (this.terminalRequest) return this.terminalTask ?? Promise.resolve();
		const terminal = {
			outcome: {
				...outcome,
				effects: mergeEffectReceipts(this.settledEffects, outcome.effects),
			},
			error,
		};
		this.terminalRequest = terminal;
		try {
			this.terminalTask = trackPostDeliveryTask(
				this.runtime,
				"RUN_ENDED",
				async () => {
					// request closes admission, so the owned set can only shrink.
					await Promise.allSettled([...this.pending]);
					await this.runtime.emitEvent(EventType.RUN_ENDED, {
						runtime: this.runtime,
						source: "messageHandler",
						runId: this.runId,
						messageId: this.message.id,
						roomId: this.message.roomId,
						entityId: this.message.entityId,
						startTime: this.startTime,
						status: terminal.outcome.status,
						outcome: terminal.outcome,
						endTime: Date.now(),
						duration: Date.now() - this.startTime,
						...(terminal.error === undefined
							? {}
							: {
									error:
										terminal.error instanceof Error
											? terminal.error
											: String(terminal.error),
								}),
					} as RunEventPayload);
				},
				{
					kind: "room-state",
					...(this.roomHandlerLease
						? {
								roomId: this.message.roomId,
								roomHandlerLease: this.roomHandlerLease,
							}
						: {}),
				},
			);
		} catch (terminalScheduleError) {
			this.terminalRequest = undefined;
			throw terminalScheduleError;
		}
		return this.terminalTask;
	}
}

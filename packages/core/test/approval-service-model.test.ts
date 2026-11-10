/** Regression checks for properties of quint/ApprovalService.qnt that the code once broke. */
import { describe, expect, it } from "vitest";
import { ApprovalService } from "../src/services/approval";
import type { UUID } from "../src/types/primitives";
import type { IAgentRuntime } from "../src/types/runtime";
import type { Task } from "../src/types/task";

/** A runtime with one task store; getTask waits until `release()` when gated. */
function runtime() {
	const tasks = new Map<UUID, Task>();
	let gate: Promise<void> | null = null;
	let open: () => void = () => undefined;
	const value = {
		agentId: "agent" as UUID,
		createTask: async (task: Task) => {
			const id = `task-${tasks.size + 1}` as UUID;
			tasks.set(id, { ...task, id });
			return id;
		},
		getTask: async (id: UUID) => {
			if (gate) await gate;
			return tasks.get(id) ?? null;
		},
		deleteTask: async (id: UUID) => {
			tasks.delete(id);
		},
		registerTaskWorker: () => undefined,
		reportError: () => undefined,
	};
	return {
		runtime: value as unknown as IAgentRuntime,
		holdGetTask: () => {
			gate = new Promise<void>((resolve) => {
				open = resolve;
			});
		},
		release: () => {
			gate = null;
			open();
		},
	};
}

const request = (calls: string[], timeoutMs?: number) => ({
	name: "MODEL_APPROVAL",
	description: "model",
	roomId: "room" as UUID,
	options: [{ name: "approve" }, { name: "deny", isCancel: true }],
	timeoutMs,
	timeoutDefault: "deny",
	onSelect: async (option: string) => {
		calls.push(`select:${option}`);
	},
	onTimeout: async () => {
		calls.push("timeout");
	},
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ApprovalService model properties", () => {
	it("runs onTimeout or onSelect, never both (AtMostOneCallback)", async () => {
		const env = runtime();
		const service = new ApprovalService(env.runtime);
		const calls: string[] = [];
		env.holdGetTask();
		const taskId = await service.requestApprovalAsync(request(calls, 5));
		await tick(20); // the timer fired and handleTimeout waits in getTask
		const selection = service.handleSelection(taskId, "approve");
		env.release();
		await selection;
		await tick(5);
		expect(calls).toHaveLength(1);
	});

	it("runs onSelect once for two concurrent selections (AtMostOneCallback)", async () => {
		const env = runtime();
		const service = new ApprovalService(env.runtime);
		const calls: string[] = [];
		const taskId = await service.requestApprovalAsync(request(calls));
		env.holdGetTask();
		const first = service.handleSelection(taskId, "approve");
		const second = service.handleSelection(taskId, "approve");
		env.release();
		await Promise.all([first, second]);
		expect(calls).toEqual(["select:approve"]);
	});

	it("does not report cancelled after onSelect ran (ResultAgrees)", async () => {
		const env = runtime();
		const service = new ApprovalService(env.runtime);
		let finish: () => void = () => undefined;
		let selected = false;
		const result = service.requestApproval({
			...request([]),
			onSelect: async () => {
				selected = true;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			},
		});
		await tick();
		const selection = service.handleSelection("task-1" as UUID, "approve");
		await tick(); // onSelect is running
		await service.cancelApproval("task-1" as UUID);
		finish();
		await selection;
		expect(selected).toBe(true);
		expect(await result).toMatchObject({ cancelled: false });
	});

	it("settles the caller when onSelect throws (CallerSettles)", async () => {
		const env = runtime();
		const service = new ApprovalService(env.runtime);
		const result = service.requestApproval({
			...request([], 60_000),
			onSelect: async () => {
				throw new Error("allowlist write failed");
			},
		});
		await tick();
		await expect(
			service.handleSelection("task-1" as UUID, "approve"),
		).rejects.toThrow("allowlist write failed");
		await expect(
			Promise.race([result, tick(50).then(() => "pending")]),
		).rejects.toThrow("allowlist write failed");
		await service.stop();
	});
});

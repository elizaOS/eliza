/** Runtime/SQLite conformance for quint/ApprovalService.qnt. */
import assert from "node:assert/strict";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../src/character.ts";
import { ElizaError } from "../src/errors.ts";
import { AgentRuntime } from "../src/runtime.ts";
import {
	type ApprovalRequest,
	ApprovalService,
} from "../src/services/approval.ts";
import type { UUID } from "../src/types/primitives.ts";
import { ServiceType } from "../src/types/service.ts";
import { stringToUuid } from "../src/utils/string-to-uuid.ts";

const roomId = stringToUuid("approval-model-room");
const pluginName = "approval-model-integration";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function gate() {
	let release = () => {};
	let enter = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		entered,
		release,
		wait: () => {
			enter();
			return pending;
		},
	};
}
const request = (calls: string[], timeoutMs?: number): ApprovalRequest => ({
	name: "MODEL_APPROVAL",
	description: "model",
	roomId,
	options: [{ name: "approve" }, { name: "deny", isCancel: true }],
	timeoutMs,
	timeoutDefault: "deny",
	onSelect: async (option) => {
		calls.push(`select:${option}`);
	},
	onTimeout: async () => {
		calls.push("timeout");
	},
});
/** Observe rejection immediately, including while a real worker is still running. */
const observe = <T>(promise: Promise<T>) =>
	promise.then(
		(value) => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	);

describe("ApprovalService model properties", () => {
	let runtime: AgentRuntime;
	let service: ApprovalService;
	beforeEach(async () => {
		const name = "ApprovalModelIntegrationAgent";
		runtime = new AgentRuntime({
			character: createCharacter({ name }),
			adapter: SQLiteDatabaseAdapter.create(":memory:", stringToUuid(name)),
			logLevel: "fatal",
			enableAutonomy: false,
		});
		await runtime.initialize();
		await runtime.registerPlugin({
			name: pluginName,
			description: "Approval conformance",
			services: [ApprovalService],
		});
		service = (await runtime.getServiceLoadPromise(
			ServiceType.APPROVAL,
		)) as ApprovalService;
	}, 180_000);
	afterEach(async () => {
		vi.restoreAllMocks();
		await runtime.stop();
		await runtime.close();
	});
	async function select(taskId: UUID) {
		const task = await runtime.getTask(taskId);
		assert(task);
		const worker = runtime.getTaskWorker("MODEL_APPROVAL");
		assert(worker);
		await worker.execute(runtime, { option: "approve" }, task);
	}
	async function pendingId() {
		await vi.waitFor(() =>
			expect(service.listPendingUserActions()).toHaveLength(1),
		);
		return service.listPendingUserActions()[0].id as UUID;
	}
	async function restartWithPersistedTasks() {
		const adapter = runtime.adapter;
		await runtime.stop(); // Retire the original owner; keep its actual SQLite handle and rows.
		runtime = new AgentRuntime({
			character: createCharacter({ name: "ApprovalModelIntegrationAgent" }),
			adapter,
			logLevel: "fatal",
			enableAutonomy: false,
		});
		await runtime.initialize();
		await runtime.registerPlugin({
			name: pluginName,
			description: "Approval conformance after runtime restart",
			services: [ApprovalService],
		});
		service = (await runtime.getServiceLoadPromise(
			ServiceType.APPROVAL,
		)) as ApprovalService;
	}

	it("runs onTimeout or onSelect, never both (AtMostOneCallback)", async () => {
		const calls: string[] = [];
		const held = gate();
		const getTask = runtime.getTask.bind(runtime);
		vi.spyOn(runtime, "getTask").mockImplementation(async (id) => {
			await held.wait();
			return getTask(id);
		});
		const taskId = await service.requestApprovalAsync(request(calls, 5));
		const task = await getTask(taskId);
		assert(task);
		const worker = runtime.getTaskWorker("MODEL_APPROVAL");
		assert(worker);
		await held.entered;
		const selection = observe(
			worker.execute(runtime, { option: "approve" }, task),
		);
		held.release();
		expect((await selection).error).toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls).toEqual(["timeout"]);
	});
	it("runs onSelect once for two concurrent selections (AtMostOneCallback)", async () => {
		const calls: string[] = [];
		const held = gate();
		const taskId = await service.requestApprovalAsync({
			...request(calls),
			onSelect: async (option) => {
				calls.push(`select:${option}`);
				await held.wait();
			},
		});
		const first = select(taskId);
		await held.entered;
		try {
			await expect(select(taskId)).rejects.toMatchObject({
				code: "APPROVAL_CALLBACK_UNAVAILABLE",
			});
		} finally {
			held.release();
		}
		await first;
		expect(calls).toEqual(["select:approve"]);
		expect(await runtime.getTask(taskId)).toBeNull();
	});
	it("does not report cancelled after onSelect ran (ResultAgrees)", async () => {
		const held = gate();
		const result = service.requestApproval({
			...request([]),
			onSelect: () => held.wait(),
		});
		const taskId = await pendingId();
		const selection = select(taskId);
		await held.entered;
		await expect(service.cancelPendingApproval(taskId)).rejects.toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		expect(await runtime.getTask(taskId)).not.toBeNull();
		await service.cancelApproval(taskId);
		held.release();
		await selection;
		expect(await result).toMatchObject({ cancelled: false, success: true });
	});

	it("confirms owned cancellation only after SQLite deletion and preserves a failed owner's retry", async () => {
		const calls: string[] = [];
		let settled = false;
		const result = service.requestApproval(request(calls, 60_000));
		void result.then(() => {
			settled = true;
		});
		const taskId = await pendingId();
		const expiresAt = service.listPendingUserActions()[0].expiresAt;
		const failure = new ElizaError("approval cancellation delete failed", {
			code: "DB_QUERY_FAILED",
		});
		vi.spyOn(runtime.adapter, "deleteTasks").mockRejectedValueOnce(failure);
		await expect(service.cancelPendingApproval(taskId)).rejects.toBe(failure);
		await tick();
		expect(settled).toBe(false);
		expect(await runtime.getTask(taskId)).not.toBeNull();
		expect(service.listPendingUserActions()[0].expiresAt).toBe(expiresAt);
		await service.cancelPendingApproval(taskId);
		expect(await result).toMatchObject({
			cancelled: true,
			success: false,
			timedOut: false,
		});
		expect(await runtime.getTask(taskId)).toBeNull();
		expect(calls).toEqual([]);
	});
	it("exclusively owns callback-free cancellation until its durable acknowledgement", async () => {
		const held = gate();
		const taskId = await service.requestApprovalAsync({
			...request([]),
			onSelect: undefined,
			onTimeout: undefined,
		});
		const remove = runtime.deleteTask.bind(runtime);
		const deletion = vi
			.spyOn(runtime, "deleteTask")
			.mockImplementationOnce(async (id) => {
				await held.wait();
				await remove(id);
			});
		const cancelling = observe(service.cancelPendingApproval(taskId));
		try {
			await held.entered;
			await expect(
				service.handleSelection(taskId, "approve"),
			).rejects.toMatchObject({ code: "APPROVAL_CALLBACK_UNAVAILABLE" });
			await expect(service.cancelPendingApproval(taskId)).rejects.toMatchObject(
				{ code: "APPROVAL_CALLBACK_UNAVAILABLE" },
			);
			await expect(service.cancelApproval(taskId)).rejects.toMatchObject({
				code: "APPROVAL_CALLBACK_UNAVAILABLE",
			});
			expect(deletion).toHaveBeenCalledOnce();
			expect(await runtime.getTask(taskId)).not.toBeNull();
		} finally {
			held.release();
		}
		expect((await cancelling).error).toBeUndefined();
		expect(await runtime.getTask(taskId)).toBeNull();
	});
	it("restores the original deadline after cancellation deletion fails past expiry", async () => {
		const calls: string[] = [];
		let settled = false;
		const result = service.requestApproval(request(calls, 1_000));
		void result.then(() => {
			settled = true;
		});
		const taskId = await pendingId();
		const expiresAt = service.listPendingUserActions()[0].expiresAt;
		assert(expiresAt !== null);
		const held = gate();
		const failure = new ElizaError("approval cancellation delete failed", {
			code: "DB_QUERY_FAILED",
		});
		vi.spyOn(runtime.adapter, "deleteTasks").mockImplementationOnce(
			async () => {
				await held.wait();
				throw failure;
			},
		);
		const cancelling = observe(service.cancelPendingApproval(taskId));
		try {
			await held.entered;
			await new Promise<void>((resolve) =>
				setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 50),
			);
			expect(settled).toBe(false);
			expect(calls).toEqual([]);
		} finally {
			held.release();
		}
		expect((await cancelling).error).toBe(failure);
		expect(service.listPendingUserActions()[0].expiresAt).toBe(expiresAt);
		expect(await result).toMatchObject({
			timedOut: true,
			cancelled: true,
			success: false,
		});
		expect(calls).toEqual(["timeout"]);
		await vi.waitFor(async () =>
			expect(await runtime.getTask(taskId)).toBeNull(),
		);
	});

	it("refuses a positive timeout receipt when cancellation deletion commits without its acknowledgement", async () => {
		const calls: string[] = [];
		const result = observe(
			service.requestApproval({
				...request(calls, 1_000),
				timeoutDefault: "approve",
			}),
		);
		const taskId = await pendingId();
		const expiresAt = service.listPendingUserActions()[0].expiresAt;
		const failure = new ElizaError(
			"approval cancellation acknowledgement lost",
			{ code: "DB_QUERY_FAILED" },
		);
		const remove = runtime.deleteTask.bind(runtime);
		vi.spyOn(runtime, "deleteTask").mockImplementationOnce(async (id) => {
			await remove(id);
			throw failure;
		});
		await expect(service.cancelPendingApproval(taskId)).rejects.toBe(failure);
		expect(await runtime.getTask(taskId)).toBeNull();
		expect(service.listPendingUserActions()[0].expiresAt).toBe(expiresAt);
		expect((await result).error).toMatchObject({
			code: "APPROVAL_TASK_UNAVAILABLE",
		});
		expect(calls).toEqual([]);
		expect(service.listPendingUserActions()).toEqual([]);
		expect(runtime.getRecentReportedErrors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scope: "ApprovalService.cancelRetryTimeout",
					code: "APPROVAL_TASK_UNAVAILABLE",
				}),
			]),
		);
	});
	for (const fail of [false, true]) {
		it(
			fail
				? "rejects an owned cancellation failure during stop without a false cancelled receipt"
				: "drains an owned cancellation acknowledgement before stop settles its caller",
			async () => {
				const held = gate();
				const calls: string[] = [];
				let settled = false;
				const result = observe(service.requestApproval(request(calls)));
				void result.then(() => {
					settled = true;
				});
				const taskId = await pendingId();
				const failure = new ElizaError("approval cancellation delete failed", {
					code: "DB_QUERY_FAILED",
				});
				const remove = runtime.adapter.deleteTasks.bind(runtime.adapter);
				vi.spyOn(runtime.adapter, "deleteTasks").mockImplementationOnce(
					async (ids) => {
						await held.wait();
						if (fail) throw failure;
						await remove(ids);
					},
				);
				const cancelling = observe(service.cancelPendingApproval(taskId));
				await held.entered;
				let stopped = false;
				const stopping = runtime.unloadPlugin(pluginName).then(() => {
					stopped = true;
				});
				try {
					await tick();
					expect(settled).toBe(false);
					expect(stopped).toBe(false);
				} finally {
					held.release();
				}
				expect((await cancelling).error).toBe(fail ? failure : undefined);
				const outcome = await result;
				if (fail) {
					expect(outcome.error).toBe(failure);
					expect(outcome.value).toBeUndefined();
				} else {
					expect(outcome.error).toBeUndefined();
					expect(outcome.value).toMatchObject({
						cancelled: true,
						success: false,
					});
				}
				await stopping;
				expect((await runtime.getTask(taskId)) === null).toBe(!fail);
				expect(service.listPendingUserActions()).toEqual([]);
				expect(calls).toEqual([]);
			},
		);
	}
	it("settles the caller when onSelect throws (CallerSettles)", async () => {
		const result = observe(
			service.requestApproval({
				...request([], 60_000),
				onSelect: async () => {
					throw new Error("allowlist write failed");
				},
			}),
		);
		const taskId = await pendingId();
		await expect(select(taskId)).rejects.toThrow("allowlist write failed");
		expect((await result).error).toMatchObject({
			message: "allowlist write failed",
		});
		expect(await runtime.getTask(taskId)).not.toBeNull();
		expect(service.listPendingUserActions()).toEqual([]);
	});
	it("rejects and reports a timeout callback failure through the real runtime", async () => {
		const result = observe(
			service.requestApproval({
				...request([], 200),
				onTimeout: async () => {
					throw new Error("timeout effect failed");
				},
			}),
		);
		const taskId = await pendingId();
		expect((await result).error).toMatchObject({
			message: "timeout effect failed",
		});
		expect(
			runtime
				.getRecentReportedErrors()
				.some(
					(error) =>
						error.scope === "ApprovalService.timeout" &&
						error.message === "timeout effect failed",
				),
		).toBe(true);
		expect(service.listPendingUserActions()).toEqual([]);
		expect(await runtime.getTask(taskId)).not.toBeNull();
	});
	it("drains admitted task creation on plugin unload and rejects late ownership", async () => {
		const held = gate();
		const createTasks = runtime.adapter.createTasks.bind(runtime.adapter);
		let taskId: UUID | undefined;
		vi.spyOn(runtime.adapter, "createTasks").mockImplementation(
			async (tasks) => {
				const ids = await createTasks(tasks);
				taskId = ids[0];
				await held.wait();
				return ids;
			},
		);
		const result = observe(service.requestApproval(request([])));
		await held.entered;
		const oldWorker = runtime.getTaskWorker("MODEL_APPROVAL");
		assert(oldWorker);
		let retired = false;
		const unload = runtime.unloadPlugin(pluginName).then(() => {
			retired = true;
		});
		await tick();
		const retiredEarly = retired;
		held.release();
		await unload;
		await tick();
		await service.stop();
		expect(retiredEarly).toBe(false);
		expect((await result).error).toMatchObject({
			code: "APPROVAL_SERVICE_STOPPED",
		});
		assert(taskId);
		expect(await runtime.getTask(taskId)).toBeNull();
		expect(service.listPendingUserActions()).toEqual([]);
		await expect(
			service.requestApprovalAsync(request([])),
		).rejects.toMatchObject({ code: "APPROVAL_SERVICE_STOPPED" });
		vi.restoreAllMocks();
		await runtime.registerPlugin({
			name: "approval-replacement",
			description: "Replacement approval owner",
			services: [ApprovalService],
		});
		service = (await runtime.getServiceLoadPromise(
			ServiceType.APPROVAL,
		)) as ApprovalService;
		const calls: string[] = [];
		const replacementId = await service.requestApprovalAsync(request(calls));
		const replacementTask = await runtime.getTask(replacementId);
		assert(replacementTask);
		await expect(
			oldWorker.execute(runtime, { option: "approve" }, replacementTask),
		).rejects.toMatchObject({ code: "APPROVAL_SERVICE_STOPPED" });
		expect(await runtime.getTask(replacementId)).not.toBeNull();
		expect(calls).toEqual([]);
		await select(replacementId);
		expect(calls).toEqual(["select:approve"]);
	});
	it("drains an already claimed callback before plugin unload completes", async () => {
		const held = gate();
		const result = service.requestApproval({
			...request([]),
			onSelect: () => held.wait(),
		});
		const taskId = await pendingId();
		const selection = select(taskId);
		await held.entered;
		let retired = false;
		const unload = runtime.unloadPlugin(pluginName).then(() => {
			retired = true;
		});
		await tick();
		const retiredEarly = retired;
		held.release();
		await Promise.all([selection, unload]);
		expect(retiredEarly).toBe(false);
		expect(await result).toMatchObject({ success: true, cancelled: false });
		expect(await runtime.getTask(taskId)).toBeNull();
	});

	it("drains a claimed timeout callback before plugin unload completes", async () => {
		const held = gate();
		const result = service.requestApproval({
			...request([], 5),
			onTimeout: () => held.wait(),
		});
		await held.entered;
		let retired = false;
		const unload = runtime.unloadPlugin(pluginName).then(() => {
			retired = true;
		});
		await tick();
		const retiredEarly = retired;
		held.release();
		await unload;
		const timeoutResult = await result;
		await vi.waitFor(async () =>
			expect(await runtime.getTask(timeoutResult.taskId)).toBeNull(),
		);
		expect(retiredEarly).toBe(false);
		expect(await result).toMatchObject({ timedOut: true, cancelled: true });
		expect(
			await runtime.getTasks({
				roomId,
				tags: ["AWAITING_CHOICE", "APPROVAL"],
				agentIds: [runtime.agentId],
			}),
		).toEqual([]);
	});

	it("cancels an unclaimed selection and drains its admitted SQLite read", async () => {
		const calls: string[] = [];
		const result = service.requestApproval(request(calls));
		const taskId = await pendingId();
		const task = await runtime.getTask(taskId);
		const worker = runtime.getTaskWorker("MODEL_APPROVAL");
		assert(task && worker);
		const held = gate();
		const read = runtime.adapter.getTasksByIds.bind(runtime.adapter);
		vi.spyOn(runtime.adapter, "getTasksByIds").mockImplementation(
			async (ids) => {
				await held.wait();
				return read(ids);
			},
		);
		const selection = worker.execute(runtime, { option: "approve" }, task);
		await held.entered;
		let retired = false;
		const unload = runtime.unloadPlugin(pluginName).then(() => {
			retired = true;
		});
		await tick();
		const retiredEarly = retired;
		held.release();
		await Promise.all([selection, unload]);
		expect(retiredEarly).toBe(false);
		expect(await result).toMatchObject({ cancelled: true, success: false });
		expect(calls).toEqual([]);
		expect(await runtime.getTask(taskId)).toBeNull();
	});

	it("drains admitted list and worker permission queries on plugin unload", async () => {
		const taskId = await service.requestApprovalAsync(request([]));
		const worker = runtime.getTaskWorker("MODEL_APPROVAL");
		assert(worker?.canExecute);
		const held = gate();
		const getTasks = runtime.getTasks.bind(runtime);
		vi.spyOn(runtime, "getTasks").mockImplementation(async (options) => {
			await held.wait();
			return getTasks(options);
		});
		const listing = service.getAllPendingApprovals();
		const permission = worker.canExecute(
			runtime,
			{
				roomId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: {},
			},
			{ values: {}, data: {}, text: "" },
		);
		await held.entered;
		let retired = false;
		const unload = runtime.unloadPlugin(pluginName).then(() => {
			retired = true;
		});
		await tick();
		const retiredEarly = retired;
		held.release();
		await Promise.all([unload, listing, permission]);
		expect(retiredEarly).toBe(false);
		expect((await listing).map((task) => task.id)).toEqual([taskId]);
		expect(await permission).toBe(true);
		await expect(service.getPendingApprovals(roomId)).rejects.toMatchObject({
			code: "APPROVAL_SERVICE_STOPPED",
		});
	});

	it("retains an unclaimed approval after selection read failure until unload", async () => {
		const calls: string[] = [];
		const result = service.requestApproval(request(calls));
		const taskId = await pendingId();
		const task = await runtime.getTask(taskId);
		const worker = runtime.getTaskWorker("MODEL_APPROVAL");
		assert(task && worker);
		const failure = new ElizaError("selection read failed", {
			code: "DB_QUERY_FAILED",
		});
		vi.spyOn(runtime.adapter, "getTasksByIds").mockRejectedValueOnce(failure);
		await expect(
			worker.execute(runtime, { option: "approve" }, task),
		).rejects.toBe(failure);
		expect(service.listPendingUserActions().map((action) => action.id)).toEqual(
			[taskId],
		);
		expect(await runtime.getTask(taskId)).not.toBeNull();
		await runtime.unloadPlugin(pluginName);
		expect(await result).toMatchObject({ cancelled: true, success: false });
		expect(calls).toEqual([]);
	});

	it("expires a callback-free asynchronous approval through its real timer", async () => {
		const taskId = await service.requestApprovalAsync({
			...request([], 5),
			onSelect: undefined,
			onTimeout: undefined,
		});
		await vi.waitFor(async () =>
			expect(await runtime.getTask(taskId)).toBeNull(),
		);
		expect(service.listPendingUserActions()).toEqual([]);
	});
	it("refuses to acknowledge a retry after its required callback failed", async () => {
		let attempts = 0;
		const taskId = await service.requestApprovalAsync({
			...request([]),
			metadata: { onSelectCallback: false, onTimeoutCallback: false },
			onSelect: async () => {
				attempts += 1;
				await runtime.setCache("approval-partial-effect", { attempts });
				throw new Error("required approval effect failed");
			},
		});
		expect((await runtime.getTask(taskId))?.metadata?.onSelectCallback).toBe(
			true,
		);
		await expect(select(taskId)).rejects.toThrow(
			"required approval effect failed",
		);
		expect(await runtime.getTask(taskId)).not.toBeNull();
		await expect(select(taskId)).rejects.toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		expect(attempts).toBe(1);
		expect(await runtime.getCache("approval-partial-effect")).toEqual({
			attempts: 1,
		});
		expect(await runtime.getTask(taskId)).not.toBeNull();
	});
	it("retains an orphaned callback task after runtime restart and permits explicit cancellation", async () => {
		const oldCalls: string[] = [];
		const taskId = await service.requestApprovalAsync(request(oldCalls));
		expect((await runtime.getTask(taskId))?.metadata?.onSelectCallback).toBe(
			true,
		);
		await restartWithPersistedTasks();
		const newCalls: string[] = [];
		const freshId = await service.requestApprovalAsync(request(newCalls)); // The real first-party worker name is registered again.
		await expect(select(taskId)).rejects.toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		expect(oldCalls).toEqual([]);
		expect(newCalls).toEqual([]);
		expect(await runtime.getTask(taskId)).not.toBeNull();
		await expect(service.cancelPendingApproval(taskId)).rejects.toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		await select(freshId);
		expect(newCalls).toEqual(["select:approve"]);
		await service.cancelApproval(taskId);
		expect(await runtime.getTask(taskId)).toBeNull();
	});
	it("selects a persisted callback-free task after runtime restart", async () => {
		const taskId = await service.requestApprovalAsync({
			...request([]),
			onSelect: undefined,
			onTimeout: undefined,
		});
		await restartWithPersistedTasks();
		const freshId = await service.requestApprovalAsync(request([]));
		await select(taskId);
		expect(await runtime.getTask(taskId)).toBeNull();
		await service.cancelApproval(freshId);
	});

	it("retains the row when deletion fails after a completed approval effect", async () => {
		const taskId = await service.requestApprovalAsync({
			...request([]),
			onSelect: async () => {
				await runtime.setCache("approval-complete-effect", "completed");
			},
		});
		const failure = new ElizaError("approval task delete failed", {
			code: "DB_QUERY_FAILED",
		});
		vi.spyOn(runtime.adapter, "deleteTasks").mockRejectedValueOnce(failure);
		await expect(select(taskId)).rejects.toBe(failure);
		expect(await runtime.getCache("approval-complete-effect")).toBe(
			"completed",
		);
		expect(await runtime.getTask(taskId)).not.toBeNull();
		await expect(select(taskId)).rejects.toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		expect(await runtime.getTask(taskId)).not.toBeNull();
	});

	it("keeps synchronous approval receipt fields source-owned despite attached metadata", async () => {
		const result = observe(
			service.requestApproval({
				...request([], 60_000),
				metadata: {
					customMarker: "kept",
					options: [{ name: "unoffered" }],
					approvalRequest: {
						isAsync: true,
						allowedRoles: ["VISITOR"],
						timeoutMs: 0,
						createdAt: -1,
					},
					onSelectCallback: false,
					onTimeoutCallback: false,
				},
				onSelect: async () => {
					await runtime.setCache("approval-sync-partial-effect", "started");
					throw new Error("sync approval effect failed");
				},
			}),
		);
		const taskId = await pendingId();
		await expect(select(taskId)).rejects.toThrow("sync approval effect failed");
		expect((await result).error).toMatchObject({
			message: "sync approval effect failed",
		});
		await expect(select(taskId)).rejects.toMatchObject({
			code: "APPROVAL_CALLBACK_UNAVAILABLE",
		});
		const task = await runtime.getTask(taskId);
		assert(task);
		expect(task.metadata?.customMarker).toBe("kept");
		expect(task.metadata?.onSelectCallback).toBe(true);
		expect(task.metadata?.onTimeoutCallback).toBe(true);
		expect(task.metadata?.options).toEqual([
			{ name: "approve", description: "" },
			{ name: "deny", description: "" },
		]);
		expect(task.metadata?.approvalRequest).toMatchObject({
			timeoutMs: 60_000,
			allowedRoles: ["OWNER", "ADMIN"],
		});
		expect(task.metadata?.approvalRequest).not.toHaveProperty("isAsync");
		expect(await runtime.getCache("approval-sync-partial-effect")).toBe(
			"started",
		);
	});
});

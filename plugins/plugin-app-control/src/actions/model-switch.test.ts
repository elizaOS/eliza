/**
 * Unit coverage for MODEL_SWITCH intent parsing, sanctioned models, and loopback dispatch.
 *
 * The route's real HTTP behavior is covered in packages/agent.
 */

import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	RoleGate,
	RoleGateRole,
	Task,
	UUID,
} from "@elizaos/core";
import { satisfiesRoleGate } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createModelSwitchAction,
	inferModelSwitchRequest,
	isModelSwitchIntent,
	type ModelSwitchFn,
	type ModelSwitchOutcome,
	sanctionedModelError,
} from "./model-switch.ts";

const pendingTasks: Task[] = [];
const runtime = {
	agentId: "agent-1" as UUID,
	getTasks: vi.fn(
		async ({
			roomId,
			tags,
			agentIds,
		}: {
			roomId?: UUID;
			tags?: string[];
			agentIds: UUID[];
		}) =>
			pendingTasks.filter(
				(task) =>
					(!roomId || task.roomId === roomId) &&
					task.agentId !== undefined &&
					agentIds.includes(task.agentId) &&
					(!tags || tags.every((tag) => task.tags?.includes(tag))),
			),
	),
	createTask: vi.fn(async (task: Task) => {
		const id = `task-${pendingTasks.length + 1}` as UUID;
		pendingTasks.push({ ...task, id });
		return id;
	}),
	deleteTask: vi.fn(async (id: UUID) => {
		const index = pendingTasks.findIndex((task) => task.id === id);
		if (index >= 0) pendingTasks.splice(index, 1);
	}),
} as unknown as IAgentRuntime;

beforeEach(() => {
	pendingTasks.splice(0);
	vi.clearAllMocks();
});

function message(text: string, roomId = "room-1" as UUID): Memory {
	return { roomId, content: { text } } as Memory;
}

function captureCallback(): {
	callback: HandlerCallback;
	texts: string[];
} {
	const texts: string[] = [];
	const callback = vi.fn(async (payload: { text?: string }) => {
		if (typeof payload.text === "string") texts.push(payload.text);
		return [];
	}) as unknown as HandlerCallback;
	return { callback, texts };
}

describe("inferModelSwitchRequest", () => {
	it("parses explicit local/cloud options", () => {
		expect(inferModelSwitchRequest("", { target: "local" })).toEqual({
			target: "local",
		});
		expect(
			inferModelSwitchRequest("", { target: "cloud", model: "gemma-4-31b" }),
		).toEqual({ target: "cloud", model: "gemma-4-31b" });
	});

	it("detects a local switch from natural language", () => {
		expect(inferModelSwitchRequest("switch to the local model")).toEqual({
			target: "local",
		});
		expect(inferModelSwitchRequest("run inference on-device")).toEqual({
			target: "local",
		});
	});

	it("detects a cloud switch from natural language", () => {
		expect(inferModelSwitchRequest("use eliza cloud")).toEqual({
			target: "cloud",
		});
		expect(inferModelSwitchRequest("switch to cloud inference")).toEqual({
			target: "cloud",
		});
	});

	it("infers the local target from a named eliza-1 tier", () => {
		expect(inferModelSwitchRequest("switch to eliza-1-4b")).toEqual({
			target: "local",
			model: "eliza-1-4b",
		});
	});

	it("returns null when no target is named", () => {
		expect(inferModelSwitchRequest("what model are you using?")).toBeNull();
		expect(inferModelSwitchRequest("hello there")).toBeNull();
		expect(inferModelSwitchRequest("")).toBeNull();
	});

	it("returns null on an ambiguous both-targets message", () => {
		expect(
			inferModelSwitchRequest("switch model between local and cloud"),
		).toBeNull();
	});
});

describe("isModelSwitchIntent", () => {
	it("recognizes preference-shaped and ambiguous model-switch asks", () => {
		expect(isModelSwitchIntent("switch to the faster model")).toBe(true);
		expect(isModelSwitchIntent("switch model between local and cloud")).toBe(
			true,
		);
	});

	it("does not claim model questions or generic settings asks", () => {
		expect(isModelSwitchIntent("what model are you using?")).toBe(false);
		expect(isModelSwitchIntent("open model settings")).toBe(false);
		expect(isModelSwitchIntent("switch to high-contrast-dark-mode")).toBe(
			false,
		);
	});
});

describe("sanctionedModelError", () => {
	it("rejects a non-curated local id", () => {
		expect(sanctionedModelError("local", "llama-3-8b")).toMatch(
			/sanctioned on-device model/,
		);
	});
	it("accepts a curated local tier", () => {
		expect(sanctionedModelError("local", "eliza-1-2b")).toBeNull();
	});
	it("rejects a non-default cloud id", () => {
		expect(sanctionedModelError("cloud", "gpt-5")).toMatch(
			/sanctioned cloud model/,
		);
	});
	it("accepts the default cloud model", () => {
		expect(
			sanctionedModelError("cloud", DEFAULT_ELIZA_CLOUD_TEXT_MODEL),
		).toBeNull();
	});
	it("allows an absent model (route resolves the default)", () => {
		expect(sanctionedModelError("local", undefined)).toBeNull();
	});
});

describe("MODEL_SWITCH handler", () => {
	function action(outcome: ModelSwitchOutcome | Error) {
		const switchModel: ModelSwitchFn = vi.fn(async () => {
			if (outcome instanceof Error) throw outcome;
			return outcome;
		});
		return { action: createModelSwitchAction({ switchModel }), switchModel };
	}

	it("validates explicit and preference-shaped switch requests", async () => {
		const { action: a } = action({ ok: true });
		expect(await a.validate(runtime, message("use the local model"))).toBe(
			true,
		);
		expect(
			await a.validate(runtime, message("switch to the faster model")),
		).toBe(true);
		expect(await a.validate(runtime, message("hi"))).toBe(false);
	});

	it("declares an OWNER role gate and optional sanctioned target param", () => {
		// #16172 gap 3: MODEL_SWITCH flips the GLOBAL inference backend, so it must
		// be OWNER-gated (matching the owner-only `/model local|cloud` slash write
		// and the sibling AGENT_SWITCH action). A planner-routed guest message must
		// not reach this action ungated.
		const { action: a } = action({ ok: true });
		expect(a.roleGate).toEqual({ minRole: "OWNER" });
		const target = a.parameters?.find((p) => p.name === "target");
		expect(target?.required).toBe(false);
		expect(target?.schema).toMatchObject({ enum: ["local", "cloud"] });
	});

	it("asks for a target instead of trusting a planner guess", async () => {
		const { action: a, switchModel } = action({ ok: true });
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to the faster model"),
			undefined,
			{ target: "cloud" },
			callback,
		);
		expect(switchModel).not.toHaveBeenCalled();
		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({ awaitingTarget: true });
		expect(texts[0]).toMatch(/local model|Eliza Cloud/);
		expect(runtime.createTask).toHaveBeenCalledTimes(1);
		expect(pendingTasks[0]?.agentId).toBe(runtime.agentId);
	});

	it("does not let a matching planner option resolve ambiguous user text", async () => {
		const { action: a, switchModel } = action({ ok: true });
		const { callback } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch model between local and cloud"),
			undefined,
			{ target: "cloud" },
			callback,
		);
		expect(switchModel).not.toHaveBeenCalled();
		expect(result?.values).toMatchObject({ awaitingTarget: true });
		expect(runtime.createTask).toHaveBeenCalledTimes(1);
	});

	it("does not let a planner invent a model tier for an explicit target", async () => {
		const { action: a, switchModel } = action({
			ok: true,
			target: "local",
		});
		const { callback } = captureCallback();
		await a.handler(
			runtime,
			message("switch to the local model"),
			undefined,
			{ target: "local", model: "eliza-1-4b" },
			callback,
		);
		expect(switchModel).toHaveBeenCalledWith({ target: "local" });
	});

	it("consumes a persisted target choice on a real second action turn", async () => {
		const { action: a, switchModel } = action({
			ok: true,
			target: "cloud",
		});
		const first = captureCallback();
		await a.handler(
			runtime,
			message("switch to the faster model"),
			undefined,
			{ target: "local" },
			first.callback,
		);
		expect(await a.validate(runtime, message("cloud"))).toBe(true);

		const second = captureCallback();
		const result = await a.handler(
			runtime,
			message("cloud"),
			undefined,
			{ target: "local" },
			second.callback,
		);
		expect(switchModel).toHaveBeenCalledTimes(1);
		expect(switchModel).toHaveBeenCalledWith({ target: "cloud" });
		expect(result?.success).toBe(true);
		expect(runtime.deleteTask).toHaveBeenCalledTimes(1);
		expect(await a.validate(runtime, message("cloud"))).toBe(false);
	});

	it("clears a consumed target choice when the route refuses the switch", async () => {
		const { action: a, switchModel } = action({
			ok: false,
			error: "no provider",
		});
		await a.handler(runtime, message("switch to the faster model"));

		const result = await a.handler(runtime, message("cloud"));

		expect(result?.success).toBe(false);
		expect(switchModel).toHaveBeenCalledTimes(1);
		expect(pendingTasks).toHaveLength(0);
		expect(await a.validate(runtime, message("cloud"))).toBe(false);
	});

	it("clears a consumed target choice when the route throws", async () => {
		const { action: a, switchModel } = action(new Error("ECONNREFUSED"));
		await a.handler(runtime, message("switch to the faster model"));

		const result = await a.handler(runtime, message("local"));

		expect(result?.success).toBe(false);
		expect(switchModel).toHaveBeenCalledTimes(1);
		expect(pendingTasks).toHaveLength(0);
	});

	it("does not switch when the pending choice cannot be claimed", async () => {
		const { action: a, switchModel } = action({ ok: true, target: "cloud" });
		await a.handler(runtime, message("switch to the faster model"));
		vi.mocked(runtime.deleteTask).mockRejectedValueOnce(
			new Error("task store unavailable"),
		);
		const { callback, texts } = captureCallback();

		const result = await a.handler(
			runtime,
			message("cloud"),
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(false);
		expect(switchModel).not.toHaveBeenCalled();
		expect(pendingTasks).toHaveLength(1);
		expect(texts[0]).toMatch(/didn't switch anything/);
	});

	it("serializes concurrent targetless asks into one pending choice", async () => {
		const { action: a, switchModel } = action({ ok: true });

		await Promise.all([
			a.handler(runtime, message("switch to the faster model")),
			a.handler(runtime, message("switch model between local and cloud")),
		]);

		expect(runtime.createTask).toHaveBeenCalledTimes(1);
		expect(pendingTasks).toHaveLength(1);
		expect(switchModel).not.toHaveBeenCalled();
	});

	it("clears every duplicate pending choice before switching", async () => {
		const { action: a, switchModel } = action({ ok: true, target: "cloud" });
		const duplicate = {
			name: "MODEL_SWITCH target choice",
			description: "Awaiting an explicit target",
			agentId: runtime.agentId,
			roomId: "room-1" as UUID,
			tags: ["MODEL_SWITCH_TARGET_CHOICE", "AWAITING_CHOICE"],
			metadata: { choiceActionName: "MODEL_SWITCH" },
		};
		await runtime.createTask(duplicate);
		await runtime.createTask(duplicate);

		const result = await a.handler(runtime, message("use cloud inference"));

		expect(result?.success).toBe(true);
		expect(runtime.deleteTask).toHaveBeenCalledTimes(2);
		expect(pendingTasks).toHaveLength(0);
		expect(switchModel).toHaveBeenCalledTimes(1);
	});

	it("allows only one concurrent answer to consume a pending choice", async () => {
		let resolveSwitch: ((outcome: ModelSwitchOutcome) => void) | undefined;
		const switchModel = vi.fn(
			() =>
				new Promise<ModelSwitchOutcome>((resolve) => {
					resolveSwitch = resolve;
				}),
		);
		const a = createModelSwitchAction({ switchModel });
		await a.handler(runtime, message("switch to the faster model"));

		const localResult = a.handler(runtime, message("local"));
		await vi.waitFor(() => expect(switchModel).toHaveBeenCalledTimes(1));
		const cloudResult = a.handler(runtime, message("cloud"));
		resolveSwitch?.({ ok: true, target: "local" });

		const [first, second] = await Promise.all([localResult, cloudResult]);
		expect(first?.success).toBe(true);
		expect(second?.success).toBe(false);
		expect(second?.text).toMatch(/no longer pending/);
		expect(switchModel).toHaveBeenCalledTimes(1);
		expect(pendingTasks).toHaveLength(0);
	});

	it("serializes global model switches across different rooms", async () => {
		let resolveFirst: ((outcome: ModelSwitchOutcome) => void) | undefined;
		const switchModel = vi
			.fn<ModelSwitchFn>()
			.mockImplementationOnce(
				() =>
					new Promise<ModelSwitchOutcome>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValueOnce({ ok: true, target: "cloud" });
		const a = createModelSwitchAction({ switchModel });

		const localResult = a.handler(
			runtime,
			message("use the local model", "room-1" as UUID),
		);
		await vi.waitFor(() => expect(switchModel).toHaveBeenCalledTimes(1));
		const cloudResult = a.handler(
			runtime,
			message("use cloud inference", "room-2" as UUID),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(switchModel).toHaveBeenCalledTimes(1);

		resolveFirst?.({ ok: true, target: "local" });
		const [first, second] = await Promise.all([localResult, cloudResult]);
		expect(first?.success).toBe(true);
		expect(second?.success).toBe(true);
		expect(switchModel).toHaveBeenNthCalledWith(1, { target: "local" });
		expect(switchModel).toHaveBeenNthCalledWith(2, { target: "cloud" });
	});

	it("narrates a cloud switch", async () => {
		const { action: a, switchModel } = action({
			ok: true,
			target: "cloud",
			model: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
			status: "ready",
		});
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("use eliza cloud"),
			undefined,
			{ target: "cloud" },
			callback,
		);
		expect(switchModel).toHaveBeenCalledWith({ target: "cloud" });
		expect(result?.success).toBe(true);
		expect(texts[0]).toMatch(/Eliza Cloud/);
	});

	it("narrates a local download in progress", async () => {
		const { action: a } = action({
			ok: true,
			target: "local",
			model: "eliza-1-2b",
			displayName: "Eliza-1 2B",
			status: "downloading",
			downloadSizeGb: 1.4,
		});
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to the local model"),
			undefined,
			{ target: "local" },
			callback,
		);
		expect(result?.success).toBe(true);
		expect(texts[0]).toMatch(/downloading \(1\.4 GB\)/);
	});

	it("refuses a non-sanctioned local model without calling the route", async () => {
		const { action: a, switchModel } = action({ ok: true });
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("use llama-3-8b locally"),
			undefined,
			{ target: "local", model: "llama-3-8b" },
			callback,
		);
		expect(switchModel).not.toHaveBeenCalled();
		expect(result?.success).toBe(false);
		expect(texts[0]).toMatch(/sanctioned on-device model/);
	});

	it("surfaces a route failure as an unsuccessful result", async () => {
		const { action: a } = action({ ok: false, error: "no provider" });
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("use cloud"),
			undefined,
			{ target: "cloud" },
			callback,
		);
		expect(result?.success).toBe(false);
		expect(texts[0]).toMatch(/no provider/);
	});

	it("surfaces a thrown transport error", async () => {
		const { action: a } = action(new Error("ECONNREFUSED"));
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to local"),
			undefined,
			{ target: "local" },
			callback,
		);
		expect(result?.success).toBe(false);
		expect(texts[0]).toMatch(/ECONNREFUSED/);
	});
});

/**
 * #16172 gap 3 regression: MODEL_SWITCH performs a GLOBAL runtime inference
 * switch, so the planner-routed action-invocation path must be OWNER-gated.
 * Before the fix the action declared `roleGate: { minRole: "USER" }`, so a
 * guest whose (possibly mention-prefixed) message slipped past the
 * deterministic command layer and reached the planner could invoke a global
 * backend switch. The runtime enforces the DECLARED gate through the shared
 * `satisfiesRoleGate` chokepoint (used by both the shortcut gate and the
 * planned-tool-call executor), so proving the declared gate rejects non-owner
 * roles proves the ungated planner path is closed.
 */
describe("MODEL_SWITCH role gate (planner path) — #16172 gap 3", () => {
	const gate = createModelSwitchAction().roleGate as RoleGate | undefined;

	const passes = (role: RoleGateRole) => satisfiesRoleGate([role], gate);

	it("declares an OWNER floor", () => {
		expect(gate).toEqual({ minRole: "OWNER" });
	});

	it("rejects a guest/user reaching the action via the planner", () => {
		expect(passes("USER" as RoleGateRole)).toBe(false);
		expect(passes("MEMBER" as RoleGateRole)).toBe(false);
	});

	it("rejects an ADMIN (a global inference switch is owner-only)", () => {
		expect(passes("ADMIN" as RoleGateRole)).toBe(false);
	});

	it("allows an OWNER", () => {
		expect(passes("OWNER" as RoleGateRole)).toBe(true);
	});
});

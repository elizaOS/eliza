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
} from "@elizaos/core";
import { satisfiesRoleGate } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createModelSwitchAction,
	inferModelSwitchRequest,
	type ModelSwitchFn,
	type ModelSwitchOutcome,
	sanctionedModelError,
} from "./model-switch.ts";

const runtime = {} as IAgentRuntime;

function message(text: string): Memory {
	return { content: { text } } as Memory;
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

	it("validates only messages that name a switch target", async () => {
		const { action: a } = action({ ok: true });
		expect(await a.validate(runtime, message("use the local model"))).toBe(
			true,
		);
		expect(await a.validate(runtime, message("hi"))).toBe(false);
	});

	it("declares an OWNER role gate and required target param", () => {
		// #16172 gap 3: MODEL_SWITCH flips the GLOBAL inference backend, so it must
		// be OWNER-gated (matching the owner-only `/model local|cloud` slash write
		// and the sibling AGENT_SWITCH action). A planner-routed guest message must
		// not reach this action ungated.
		const { action: a } = action({ ok: true });
		expect(a.roleGate).toEqual({ minRole: "OWNER" });
		const target = a.parameters?.find((p) => p.name === "target");
		expect(target?.required).toBe(true);
		expect(target?.schema).toMatchObject({ enum: ["local", "cloud"] });
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

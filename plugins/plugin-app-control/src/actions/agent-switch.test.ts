// Unit coverage for the AGENT_SWITCH action: profile-query parsing, the OWNER
// role gate, and the handler driving a mocked loopback switch client. The
// client-side trust gate + real switch live in packages/ui; the route
// round-trip lives in packages/agent.

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentSwitchFn,
	type AgentSwitchOutcome,
	createAgentSwitchAction,
	inferAgentSwitchProfile,
} from "./agent-switch.ts";

const runtime = {} as IAgentRuntime;

function message(text: string): Memory {
	return { content: { text } } as Memory;
}

function captureCallback(): { callback: HandlerCallback; texts: string[] } {
	const texts: string[] = [];
	const callback = vi.fn(async (payload: { text?: string }) => {
		if (typeof payload.text === "string") texts.push(payload.text);
		return [];
	}) as unknown as HandlerCallback;
	return { callback, texts };
}

describe("inferAgentSwitchProfile", () => {
	it("uses an explicit profile option", () => {
		expect(inferAgentSwitchProfile("", { profile: "cloud" })).toBe("cloud");
		expect(inferAgentSwitchProfile("", { agent: "laptop" })).toBe("laptop");
	});

	it("extracts the label before the agent/runtime noun", () => {
		expect(inferAgentSwitchProfile("switch to my cloud agent")).toBe("cloud");
		expect(inferAgentSwitchProfile("use the laptop runtime")).toBe("laptop");
		expect(inferAgentSwitchProfile("connect to my VPS agent")).toBe("VPS");
	});

	it("extracts a label after 'to' when a noun is present", () => {
		expect(inferAgentSwitchProfile("switch to the production backend")).toBe(
			"production",
		);
	});

	it("returns null when no agent/runtime noun is present (defers to MODEL_SWITCH)", () => {
		// A bare "switch to local" has no agent/runtime noun — the conservative
		// gate defers it so it doesn't contend with MODEL_SWITCH's local/cloud.
		expect(inferAgentSwitchProfile("switch back to local")).toBeNull();
		expect(inferAgentSwitchProfile("what agent am I on?")).toBeNull();
		expect(inferAgentSwitchProfile("hello")).toBeNull();
		expect(inferAgentSwitchProfile("")).toBeNull();
	});
});

describe("AGENT_SWITCH handler", () => {
	function action(outcome: AgentSwitchOutcome | Error) {
		const switchAgent: AgentSwitchFn = vi.fn(async () => {
			if (outcome instanceof Error) throw outcome;
			return outcome;
		});
		return { action: createAgentSwitchAction({ switchAgent }), switchAgent };
	}

	it("is OWNER role-gated (repoints the backend)", () => {
		const { action: a } = action({ ok: true });
		expect(a.roleGate).toEqual({ minRole: "OWNER" });
		const profile = a.parameters?.find((p) => p.name === "profile");
		expect(profile?.required).toBe(true);
	});

	it("validates only agent-switch phrasings", async () => {
		const { action: a } = action({ ok: true });
		expect(await a.validate(runtime, message("switch to my cloud agent"))).toBe(
			true,
		);
		expect(await a.validate(runtime, message("good morning"))).toBe(false);
	});

	it("confirms a successful switch with the resolved label", async () => {
		const { action: a, switchAgent } = action({
			ok: true,
			profileId: "p-cloud",
			profileLabel: "My Cloud Agent",
		});
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to my cloud agent"),
			undefined,
			undefined,
			callback,
		);
		expect(switchAgent).toHaveBeenCalledWith("cloud");
		expect(result?.success).toBe(true);
		expect(texts[0]).toMatch(/My Cloud Agent/);
	});

	it("reports an unknown profile refusal", async () => {
		const { action: a } = action({ ok: false, reason: "not-found" });
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to the ghost agent"),
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(false);
		expect(texts[0]).toMatch(/couldn't find a saved runtime/);
	});

	it("reports an untrusted-remote refusal with the security reason", async () => {
		const { action: a } = action({ ok: false, reason: "untrusted-remote" });
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to my vps agent"),
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(false);
		expect(texts[0]).toMatch(/isn't a trusted local\/VPN host/);
	});

	it("reports no connected shell", async () => {
		const { action: a } = action({ ok: false, reason: "no-shell" });
		const { callback, texts } = captureCallback();
		const result = await a.handler(
			runtime,
			message("switch to my cloud agent"),
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(false);
		expect(texts[0]).toMatch(/No app window is connected/);
	});
});

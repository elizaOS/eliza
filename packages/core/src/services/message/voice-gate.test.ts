/**
 * Unit tests for the humanness voice gate's branching contract (#14873):
 * injected literal gets rephrased, already-voiced/empty text skips the model,
 * a rephrase failure or blank output delivers the ORIGINAL text and reports the
 * error, and identical inputs are served from the cache. The model is a
 * deterministic injected stub (the gate's branching, not the model, is under
 * test); the real model path is covered by the live scenario in the PR.
 */
import { describe, expect, it, vi } from "vitest";
import type { Content } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { ModelType } from "../../types/model";
import { buildVoiceGatePrompt, ensureAgentVoice } from "./voice-gate";

interface FakeRuntimeOptions {
	useModel?: (type: string, params: { prompt: string }) => Promise<unknown>;
}

function makeRuntime(options: FakeRuntimeOptions = {}) {
	const reportError = vi.fn();
	const runtime = {
		agentId: "11111111-1111-1111-1111-111111111111",
		character: {
			name: "Ada",
			bio: ["a warm, direct assistant"],
			style: { all: ["speaks plainly"], chat: ["no corporate tone"] },
		},
		useModel: options.useModel,
		reportError,
	} as unknown as IAgentRuntime;
	return { runtime, reportError };
}

describe("ensureAgentVoice", () => {
	it("rephrases an injected hardcoded literal into the agent voice", async () => {
		const useModel = vi.fn(async () => "Heads up, that did not go through.");
		const { runtime } = makeRuntime({ useModel });
		const content: Content = {
			text: "Error: connector not connected.",
			source: "escalation",
		};

		const out = await ensureAgentVoice(runtime, content, {
			source: "escalation",
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[0][0]).toBe(ModelType.TEXT_SMALL);
		expect(out.text).toBe("Heads up, that did not go through.");
		expect(out.agentVoiced).toBe(true);
		// Input is untouched (returns a new object).
		expect(content.text).toBe("Error: connector not connected.");
	});

	it("passes already-voiced text through without calling the model", async () => {
		const useModel = vi.fn(async () => "should not run");
		const { runtime } = makeRuntime({ useModel });
		const content: Content = {
			text: "The owner's own words, verbatim.",
			source: "inbox",
			agentVoiced: true,
		};

		const out = await ensureAgentVoice(runtime, content, { source: "inbox" });

		expect(useModel).not.toHaveBeenCalled();
		expect(out).toBe(content);
	});

	it("short-circuits empty text without calling the model", async () => {
		const useModel = vi.fn(async () => "x");
		const { runtime } = makeRuntime({ useModel });
		const content: Content = { text: "   ", source: "autonomy" };

		const out = await ensureAgentVoice(runtime, content, { source: "autonomy" });

		expect(useModel).not.toHaveBeenCalled();
		expect(out).toBe(content);
	});

	it("delivers the ORIGINAL text and reports the error when rephrase throws", async () => {
		const useModel = vi.fn(async () => {
			throw new Error("model surface down");
		});
		const { runtime, reportError } = makeRuntime({ useModel });
		const content: Content = {
			text: "Raw internal failure text.",
			source: "connector",
		};

		const out = await ensureAgentVoice(runtime, content, {
			source: "connector",
		});

		expect(out.text).toBe("Raw internal failure text.");
		expect(out.agentVoiced).toBeUndefined();
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError.mock.calls[0][0]).toBe("voice-gate");
	});

	it("delivers the original and reports when the model returns blank output", async () => {
		const useModel = vi.fn(async () => "   ");
		const { runtime, reportError } = makeRuntime({ useModel });
		const content: Content = { text: "Keep this.", source: "escalation" };

		const out = await ensureAgentVoice(runtime, content, {
			source: "escalation",
		});

		expect(out.text).toBe("Keep this.");
		expect(out.agentVoiced).toBeUndefined();
		expect(reportError).toHaveBeenCalledTimes(1);
	});

	it("serves an identical input from cache without a second model call", async () => {
		const useModel = vi.fn(async () => "Cached voice output here.");
		const { runtime } = makeRuntime({ useModel });
		const literal = `unique-cache-probe-${Math.random()}`;

		const first = await ensureAgentVoice(
			runtime,
			{ text: literal, source: "cache-test" },
			{ source: "cache-test" },
		);
		const second = await ensureAgentVoice(
			runtime,
			{ text: literal, source: "cache-test" },
			{ source: "cache-test" },
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(first.text).toBe("Cached voice output here.");
		expect(second.text).toBe("Cached voice output here.");
	});

	it("passes through unchanged when the runtime has no model surface", async () => {
		const { runtime } = makeRuntime({ useModel: undefined });
		const content: Content = { text: "no model here", source: "autonomy" };

		const out = await ensureAgentVoice(runtime, content, { source: "autonomy" });

		expect(out).toBe(content);
	});
});

describe("buildVoiceGatePrompt", () => {
	it("embeds persona and pins the value-preserving hard rules", () => {
		const prompt = buildVoiceGatePrompt(
			{
				name: "Ada",
				bio: ["a warm, direct assistant"],
				style: { all: ["speaks plainly"] },
			} as IAgentRuntime["character"],
			"You have 3 new messages at /inbox.",
		);

		expect(prompt).toContain("You are Ada.");
		expect(prompt).toContain("a warm, direct assistant");
		expect(prompt).toContain("Preserve every exact value");
		expect(prompt).toContain("Do not use em-dashes");
		expect(prompt).toContain("You have 3 new messages at /inbox.");
	});
});

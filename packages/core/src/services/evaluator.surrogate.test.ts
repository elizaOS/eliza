/**
 * Regression for the shared-context tail truncation of the merged evaluator
 * prompt (`trimTailForPrompt`).
 *
 * These cases drive the real `EvaluatorService.run` and inspect the prompt
 * handed to `useModel`, because that string is what a provider serializes. A
 * negative slice taken at an arbitrary UTF-16 index can start on the low half
 * of a surrogate pair; the lone surrogate then serializes as a `\uDCxx` escape
 * that strict provider JSON parsers reject outright.
 *
 * The retained shared budget depends on how the fair-share allocator splits the
 * remaining characters, so the boundary parity is swept rather than assumed.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Character, Memory } from "../types";
import { EVALUATOR_PROMPT_MAX_CHARS, EvaluatorService } from "./evaluator";

const FOX = "\u{1F98A}";
const REPLACEMENT_CHARACTER = "�";
const TRUNCATION_MARKER = "[... truncated; kept latest tail ...]";

function isWellFormed(value: string): boolean {
	const native = value as unknown as { isWellFormed?: () => boolean };
	if (typeof native.isWellFormed === "function") return native.isWellFormed();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "EvaluatorSurrogateAgent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: {},
		data: {},
		text: "",
	}));
	runtime.emitEvent = vi.fn(async () => {});
	return runtime;
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as Memory["id"],
		entityId: "00000000-0000-0000-0000-000000000002" as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text, source: "test" },
	} as Memory;
}

/**
 * Runs one turn and returns the prompt the model received. `messageText` shifts
 * the fair-share split by one character per added byte, which is what moves the
 * shared-context cut across a surrogate boundary.
 */
async function promptFor(
	providerContext: string,
	messageText = "hi",
): Promise<string> {
	const runtime = makeRuntime();
	runtime.registerEvaluator({
		name: "alpha",
		description: "alpha section",
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
		shouldRun: async () => true,
		prompt: () => "Extract alpha.",
		parse: (output) => output as never,
		processors: [
			{ name: "storeAlpha", process: async () => ({ success: true }) },
		],
	});
	let captured: string | undefined;
	runtime.useModel = vi.fn(async (_modelType, params) => {
		captured = String(params.messages?.[0]?.content ?? "");
		return { alpha: { ok: true } };
	}) as AgentRuntime["useModel"];
	const result = await new EvaluatorService(runtime).run(
		makeMessage(messageText),
		{ values: {}, data: {}, text: providerContext },
	);
	expect(result.errors).toEqual([]);
	expect(captured).toBeDefined();
	return captured as string;
}

describe("evaluator shared-context tail truncation is surrogate-safe", () => {
	it("never emits a lone surrogate across shared-budget parities", async () => {
		const context = FOX.repeat(EVALUATOR_PROMPT_MAX_CHARS);
		const illFormed: number[] = [];
		for (let pad = 0; pad < 8; pad++) {
			const prompt = await promptFor(context, `hi${"!".repeat(pad)}`);
			expect(prompt).toContain(TRUNCATION_MARKER);
			expect(prompt.length).toBeLessThanOrEqual(EVALUATOR_PROMPT_MAX_CHARS);
			if (!isWellFormed(prompt)) illFormed.push(pad);
		}
		expect(illFormed).toEqual([]);
	}, 60_000);

	it("serializes to a provider body with no lone-surrogate escape", async () => {
		const prompt = await promptFor(
			FOX.repeat(EVALUATOR_PROMPT_MAX_CHARS),
			"hi!",
		);
		const body = JSON.stringify({ messages: [{ content: prompt }] });
		expect(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(body)).toBe(false);
		expect(JSON.parse(body).messages[0].content).toBe(prompt);
	}, 60_000);

	it("sanitizes a pre-existing lone surrogate instead of forwarding it", async () => {
		const lone = String.fromCharCode(0xd83d);
		const prompt = await promptFor(
			`${lone}TAIL_SENTINEL${"z".repeat(EVALUATOR_PROMPT_MAX_CHARS)}${lone}END`,
		);
		expect(isWellFormed(prompt)).toBe(true);
		expect(prompt).toContain(`${REPLACEMENT_CHARACTER}END`);
	}, 60_000);

	it("keeps ASCII shared context byte-identical to a plain tail slice", async () => {
		// No over-rejection: for input the live path already accepts, the
		// retained window must be exactly the trailing characters, unmodified.
		const context = Array.from(
			{ length: EVALUATOR_PROMPT_MAX_CHARS },
			(_unused, index) => String.fromCharCode(0x41 + (index % 26)),
		).join("");
		const prompt = await promptFor(context);
		expect(prompt).not.toContain(REPLACEMENT_CHARACTER);
		const markerAt = prompt.indexOf(TRUNCATION_MARKER);
		expect(markerAt).toBeGreaterThan(-1);
		const sectionStart = prompt.indexOf("Provider context:\n");
		expect(sectionStart).toBeGreaterThan(-1);
		const sectionEnd = prompt.indexOf("\n\n## Active Evaluators");
		expect(sectionEnd).toBeGreaterThan(sectionStart);
		const rendered = prompt
			.slice(sectionStart + "Provider context:\n".length, sectionEnd)
			.replace(/\n+$/, "");
		const retained = rendered.slice(
			rendered.lastIndexOf(TRUNCATION_MARKER) + TRUNCATION_MARKER.length + 1,
		);
		expect(retained.length).toBeGreaterThan(1000);
		expect(context.endsWith(retained)).toBe(true);
	}, 60_000);

	it("passes short well-formed context through untouched", async () => {
		const context = `short evaluator context with ${FOX} emoji`;
		const prompt = await promptFor(context);
		expect(prompt).toContain(context);
		expect(prompt).not.toContain(TRUNCATION_MARKER);
		expect(isWellFormed(prompt)).toBe(true);
	}, 60_000);
});

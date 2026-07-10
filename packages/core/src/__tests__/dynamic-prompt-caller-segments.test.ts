/**
 * Exercises the caller-supplied promptSegments path of
 * AgentRuntime.dynamicPromptExecFromState (#15742): a caller that assembles
 * its own prompt (the PromptBatcher dispatcher) can pass stable/dynamic
 * segment structure alongside the flat prompt. The segmentation is adopted
 * only when it reproduces the rendered template byte-for-byte — the prompt
 * text the model sees is provably unchanged — and is dropped otherwise.
 * Runs against a bare AgentRuntime with a registered vi.fn() model handler —
 * fully deterministic, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { type Character, ModelType } from "../types";
import type { PromptSegment } from "../types/model";

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "dynamic-prompt-caller-segments-test",
			bio: "test",
			settings: {},
		} as Character,
		logLevel: "fatal",
	});
	// No DB adapter on this minimal runtime — stub the pure-logging call so
	// useModel returns the handler output cleanly (see
	// dynamic-prompt-json-mode.test.ts for the original rationale).
	(runtime as unknown as { logModelCall: () => void }).logModelCall = () => {};
	return runtime;
}

const HEADER =
	"You are answering multiple independent structured sections in one response.\n\n";
const SECTION_BLOCK = "SECTION 1: first\n\nContext:\ncontext for first";
const PROMPT = `${HEADER}${SECTION_BLOCK}`;

describe("AgentRuntime.dynamicPromptExecFromState caller promptSegments", () => {
	it("adopts caller segments when they reproduce the rendered prompt byte-for-byte", async () => {
		const runtime = makeRuntime();
		let seenParams:
			| { prompt?: string; promptSegments?: PromptSegment[] }
			| undefined;
		const handler = vi.fn(
			async (
				_runtime,
				params: { prompt?: string; promptSegments?: PromptSegment[] },
			) => {
				seenParams = params;
				return '{"answer":"ok"}';
			},
		);
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		await runtime.dynamicPromptExecFromState({
			params: {
				prompt: PROMPT,
				promptSegments: [
					{ content: HEADER, stable: true },
					{ content: SECTION_BLOCK, stable: false },
				],
			},
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 0 },
		});

		expect(handler).toHaveBeenCalledTimes(1);
		const segments = seenParams?.promptSegments ?? [];
		expect(segments.length).toBeGreaterThan(1);
		// The caller's stable/dynamic boundary survives into the segments the
		// model handler receives: the header is its own stable segment and the
		// volatile section context is NOT part of any stable segment.
		expect(segments[0]).toMatchObject({ content: HEADER, stable: true });
		expect(segments[1]?.stable).toBe(false);
		expect(segments[1]?.content).toContain("context for first");
		for (const segment of segments) {
			if (segment.stable) {
				expect(segment.content).not.toContain("context for first");
			}
		}
		// The full prompt text is byte-identical to segment concatenation.
		expect(segments.map((segment) => segment.content).join("")).toBe(
			seenParams?.prompt,
		);
	});

	it("falls back to template segmentation when caller segments do not reproduce the prompt", async () => {
		const runtime = makeRuntime();
		let seenParams:
			| { prompt?: string; promptSegments?: PromptSegment[] }
			| undefined;
		const handler = vi.fn(
			async (
				_runtime,
				params: { prompt?: string; promptSegments?: PromptSegment[] },
			) => {
				seenParams = params;
				return '{"answer":"ok"}';
			},
		);
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		await runtime.dynamicPromptExecFromState({
			params: {
				prompt: PROMPT,
				// Joined content diverges from the prompt — must be rejected so
				// the model still sees the true rendered text.
				promptSegments: [{ content: "SOMETHING ELSE ENTIRELY", stable: true }],
			},
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 0 },
		});

		expect(handler).toHaveBeenCalledTimes(1);
		const segments = seenParams?.promptSegments ?? [];
		// Fallback: the rendered template is one segment (no placeholders), so
		// the header and section context stay in the SAME segment — the bogus
		// caller boundary did not leak through.
		const first = segments[0];
		expect(first?.content).toContain(
			"You are answering multiple independent structured sections",
		);
		expect(first?.content).toContain("context for first");
		expect(
			segments.some((segment) =>
				segment.content.includes("SOMETHING ELSE ENTIRELY"),
			),
		).toBe(false);
		expect(segments.map((segment) => segment.content).join("")).toBe(
			seenParams?.prompt,
		);
	});

	it("routes a caller segment ttl hint into the Anthropic cache plan (#15742)", async () => {
		const runtime = makeRuntime();
		let seenParams:
			| {
					providerOptions?: {
						anthropic?: {
							cacheBreakpoints?: Array<{
								segmentIndex: number;
								ttl: string;
								cacheControl: { type: string; ttl?: string };
							}>;
						};
					};
			  }
			| undefined;
		const handler = vi.fn(async (_runtime, params: unknown) => {
			seenParams = params as typeof seenParams;
			return '{"answer":"ok"}';
		});
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "test", 100);

		await runtime.dynamicPromptExecFromState({
			params: {
				prompt: PROMPT,
				promptSegments: [
					{ content: HEADER, stable: true, ttl: "long" },
					{ content: SECTION_BLOCK, stable: false },
				],
			},
			schema: [{ field: "answer", description: "Answer", required: true }],
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 0 },
		});

		expect(handler).toHaveBeenCalledTimes(1);
		const breakpoints =
			seenParams?.providerOptions?.anthropic?.cacheBreakpoints ?? [];
		expect(breakpoints.length).toBeGreaterThan(0);
		// The caller-marked long-TTL stable segment surfaces as a 1h ephemeral
		// breakpoint in the provider cache plan.
		expect(breakpoints[0]).toMatchObject({
			segmentIndex: 0,
			ttl: "long",
			cacheControl: { type: "ephemeral", ttl: "1h" },
		});
	});
});

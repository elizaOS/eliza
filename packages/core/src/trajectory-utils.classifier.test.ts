/**
 * Covers the trajectory-utils exports that no test in the repo imports: the
 * context-object extractors, the strict-mode guards and their model-type
 * classifier, the trajectory-logger resolver, and the training-exclusion
 * registry.
 *
 * The classifier is the interesting one. It decides which `runtime.useModel`
 * calls `ELIZA_TRAJECTORY_STRICT=1` polices, so its partition over `ModelType`
 * is enumerated here in full rather than sampled — see the note on `PII_SCRUB`
 * below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "./trajectory-context";
import {
	__resetTrajectorySourceRegistryForTests,
	assertActiveTrajectoryForLlmCall,
	assertRecordedLlmCall,
	extractContextEventsFromTrajectory,
	extractContextObjectFromTrajectory,
	isExcludedFromTraining,
	isLlmGenerationModelType,
	isTrajectoryStrictModeEnabled,
	normalizeTrajectoryLlmPurpose,
	registerTrajectorySource,
	resolveTrajectoryLogger,
	TRAJECTORY_LLM_PURPOSES,
} from "./trajectory-utils";
import type { IAgentRuntime } from "./types";
import { ModelType } from "./types";

const STRICT = "ELIZA_TRAJECTORY_STRICT";
const previousStrict = process.env[STRICT];

afterEach(() => {
	if (previousStrict === undefined) delete process.env[STRICT];
	else process.env[STRICT] = previousStrict;
});

/** Runs `fn` with an active trajectory step id in context. */
function withActiveStep<T>(fn: () => T): T {
	return runWithTrajectoryContext(
		{ trajectoryStepId: "step-1" } as never,
		fn,
	) as T;
}

describe("extractContextObjectFromTrajectory", () => {
	it("reads a context object carried directly on the trajectory", () => {
		const found = extractContextObjectFromTrajectory({
			contextObject: { id: "ctx-1", version: "v6", events: [{ kind: "a" }] },
		});
		expect(found?.id).toBe("ctx-1");
		expect(found?.version).toBe("v6");
		expect(found?.events).toHaveLength(1);
	});

	it("falls back to metadata.contextObject", () => {
		const found = extractContextObjectFromTrajectory({
			metadata: { contextObject: { events: [] } },
		});
		expect(found).not.toBeNull();
	});

	it("prefers the direct object over the metadata copy", () => {
		const found = extractContextObjectFromTrajectory({
			contextObject: { id: "direct", events: [] },
			metadata: { contextObject: { id: "from-metadata", events: [] } },
		});
		expect(found?.id).toBe("direct");
	});

	it("supplies defaults for a missing or blank id and version", () => {
		for (const id of [undefined, "", "   ", 7]) {
			const found = extractContextObjectFromTrajectory({
				contextObject: { id, events: [] },
			});
			expect(found?.id).toBe("context-object");
			expect(found?.version).toBe("v5");
		}
	});

	it("copies the event array instead of aliasing it", () => {
		// A caller that mutates the returned events must not corrupt the source.
		const events = [{ kind: "a" }];
		const found = extractContextObjectFromTrajectory({
			contextObject: { events },
		});
		expect(found?.events).not.toBe(events);
		found?.events.push({ kind: "b" } as never);
		expect(events).toHaveLength(1);
	});

	it("returns null for anything without an events array", () => {
		for (const value of [
			null,
			undefined,
			"trajectory",
			7,
			[],
			{},
			{ contextObject: {} },
			{ contextObject: { events: "not-an-array" } },
			{ metadata: "nope", contextObject: null },
		]) {
			expect(extractContextObjectFromTrajectory(value)).toBeNull();
		}
	});
});

describe("extractContextEventsFromTrajectory", () => {
	it("prefers the context object's events", () => {
		const events = extractContextEventsFromTrajectory({
			contextObject: { events: [{ kind: "from-context-object" }] },
			events: [{ kind: "top-level" }],
		});
		expect(events).toEqual([{ kind: "from-context-object" }]);
	});

	it("falls back to a top-level events array, then to metadata.contextEvents", () => {
		expect(
			extractContextEventsFromTrajectory({ events: [{ kind: "top" }] }),
		).toEqual([{ kind: "top" }]);
		expect(
			extractContextEventsFromTrajectory({
				metadata: { contextEvents: [{ kind: "meta" }] },
			}),
		).toEqual([{ kind: "meta" }]);
	});

	it("copies rather than aliases each source", () => {
		const events = [{ kind: "a" }];
		expect(extractContextEventsFromTrajectory({ events })).not.toBe(events);
		const metaEvents = [{ kind: "a" }];
		expect(
			extractContextEventsFromTrajectory({
				metadata: { contextEvents: metaEvents },
			}),
		).not.toBe(metaEvents);
	});

	it("returns null when no source carries events", () => {
		for (const value of [null, "x", 7, {}, { metadata: {} }]) {
			expect(extractContextEventsFromTrajectory(value)).toBeNull();
		}
	});
});

describe("isTrajectoryStrictModeEnabled", () => {
	it("is off when the variable is unset", () => {
		delete process.env[STRICT];
		expect(isTrajectoryStrictModeEnabled()).toBe(false);
	});

	it("is on for the documented truthy spellings", () => {
		for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
			process.env[STRICT] = raw;
			expect(isTrajectoryStrictModeEnabled()).toBe(true);
		}
	});

	it("stays off for falsy spellings, including the string 'false'", () => {
		// "false" is truthy as a JS string; a bare Boolean() would enable strict
		// mode for an operator who explicitly turned it off.
		for (const raw of ["", "0", "false", "no", "off"]) {
			process.env[STRICT] = raw;
			expect(isTrajectoryStrictModeEnabled()).toBe(false);
		}
	});
});

describe("normalizeTrajectoryLlmPurpose", () => {
	it("accepts every declared purpose", () => {
		for (const purpose of TRAJECTORY_LLM_PURPOSES) {
			expect(normalizeTrajectoryLlmPurpose(purpose)).toBe(purpose);
		}
	});

	it("trims and lowercases before matching", () => {
		expect(normalizeTrajectoryLlmPurpose("  PLANNER  ")).toBe("planner");
		expect(normalizeTrajectoryLlmPurpose("Evaluator")).toBe("evaluator");
	});

	it("defaults to external_llm for unknown, empty and nullish input", () => {
		for (const value of [undefined, null, "", "   ", "nonsense"]) {
			expect(normalizeTrajectoryLlmPurpose(value)).toBe("external_llm");
		}
	});

	it("honours an explicit fallback only when the value does not match", () => {
		expect(normalizeTrajectoryLlmPurpose(undefined, "planner")).toBe("planner");
		expect(normalizeTrajectoryLlmPurpose("bogus", "action")).toBe("action");
		expect(normalizeTrajectoryLlmPurpose("optimizer", "action")).toBe(
			"optimizer",
		);
	});
});

describe("isLlmGenerationModelType", () => {
	it("classifies every text-generation slot as generative", () => {
		for (const modelType of [
			ModelType.TEXT_NANO,
			ModelType.TEXT_SMALL,
			ModelType.TEXT_MEDIUM,
			ModelType.TEXT_LARGE,
			ModelType.TEXT_MEGA,
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.TEXT_REASONING_SMALL,
			ModelType.TEXT_REASONING_LARGE,
			ModelType.TEXT_COMPLETION,
			ModelType.RESEARCH,
		]) {
			expect(isLlmGenerationModelType(modelType)).toBe(true);
		}
	});

	it("classifies structured-output slots by their OBJECT_ prefix", () => {
		// No OBJECT_* member exists on ModelType today; the prefix rule is
		// forward-looking, so it is pinned directly.
		expect(isLlmGenerationModelType("OBJECT_SMALL")).toBe(true);
		expect(isLlmGenerationModelType("OBJECT_LARGE")).toBe(true);
		expect(isLlmGenerationModelType("OBJECTIVE")).toBe(false);
	});

	it("excludes the embedding, tokenizer and speech slots the docstring names", () => {
		for (const modelType of [
			ModelType.TEXT_EMBEDDING,
			ModelType.TEXT_EMBEDDING_BATCH,
			ModelType.TEXT_TOKENIZER_ENCODE,
			ModelType.TEXT_TOKENIZER_DECODE,
			ModelType.TEXT_TO_SPEECH,
			ModelType.TRANSCRIPTION,
		]) {
			expect(isLlmGenerationModelType(modelType)).toBe(false);
		}
	});

	it("excludes the media slots", () => {
		for (const modelType of [
			ModelType.IMAGE,
			ModelType.IMAGE_DESCRIPTION,
			ModelType.AUDIO,
			ModelType.VIDEO,
		]) {
			expect(isLlmGenerationModelType(modelType)).toBe(false);
		}
	});

	it("normalizes case and surrounding whitespace", () => {
		expect(isLlmGenerationModelType("  text_large  ")).toBe(true);
		expect(isLlmGenerationModelType("Text_Embedding")).toBe(false);
	});

	it("is false for empty and non-string input rather than throwing", () => {
		for (const value of [undefined, null, "", "   ", 7, {}, []]) {
			expect(isLlmGenerationModelType(value)).toBe(false);
		}
	});

	it("leaves NO ModelType member unclassified", () => {
		// Guards against a new slot silently landing in neither bucket by
		// accident; every member must yield a boolean decision.
		for (const modelType of Object.values(ModelType)) {
			expect(typeof isLlmGenerationModelType(modelType)).toBe("boolean");
		}
	});

	it("currently does NOT police PII_SCRUB — see the PR note", () => {
		// PII_SCRUB is a real `runtime.useModel` LLM call (pii-scrub-seam.ts)
		// that can be served by Eliza Cloud, yet it is none of the three
		// categories the docstring says are "intentionally excluded"
		// (embeddings, tokenizers, speech/transcription/media). This assertion
		// records today's behavior so the discrepancy is explicit and a decision
		// to change it is a one-line diff plus this line.
		expect(isLlmGenerationModelType(ModelType.PII_SCRUB)).toBe(false);
	});
});

describe("assertActiveTrajectoryForLlmCall", () => {
	it("returns null and does not throw when strict mode is off", () => {
		delete process.env[STRICT];
		expect(assertActiveTrajectoryForLlmCall()).toBeNull();
	});

	it("throws in strict mode with no active trajectory step", () => {
		process.env[STRICT] = "1";
		expect(() => assertActiveTrajectoryForLlmCall()).toThrow(
			/trajectory-strict/,
		);
	});

	it("returns the active step id in strict mode instead of throwing", () => {
		process.env[STRICT] = "1";
		expect(withActiveStep(() => assertActiveTrajectoryForLlmCall())).toBe(
			"step-1",
		);
	});

	it("names the offending call in the message so the fix is locatable", () => {
		process.env[STRICT] = "1";
		try {
			assertActiveTrajectoryForLlmCall({
				actionType: "runtime.useModel",
				model: "gpt-x",
				modelType: "TEXT_LARGE",
				purpose: "action",
			});
			throw new Error("expected a strict-mode refusal");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("actionType=runtime.useModel");
			expect(message).toContain("model=gpt-x");
			expect(message).toContain("modelType=TEXT_LARGE");
			expect(message).toContain("purpose=action");
			// The remedy is part of the contract, not decoration.
			expect(message).toContain("recordLlmCall");
			expect(message).toContain("withStandaloneTrajectory");
		}
	});

	it("omits the parenthetical entirely when no context is supplied", () => {
		process.env[STRICT] = "1";
		try {
			assertActiveTrajectoryForLlmCall({});
			throw new Error("expected a strict-mode refusal");
		} catch (error) {
			expect((error as Error).message).toContain("outside trajectory.");
		}
	});
});

describe("assertRecordedLlmCall", () => {
	it("is a no-op outside strict mode", () => {
		delete process.env[STRICT];
		expect(() => assertRecordedLlmCall()).not.toThrow();
	});

	it("reports the missing trajectory first, before the wrapping complaint", () => {
		// Order matters: telling a caller to wrap in recordLlmCall is useless
		// advice when the real problem is that no trajectory is running.
		process.env[STRICT] = "1";
		expect(() => assertRecordedLlmCall()).toThrow(/outside trajectory/);
	});

	it("throws the unwrapped-call error when a trajectory IS active", () => {
		process.env[STRICT] = "1";
		expect(() => withActiveStep(() => assertRecordedLlmCall())).toThrow(
			/not wrapped by recordLlmCall/,
		);
	});
});

describe("resolveTrajectoryLogger", () => {
	function runtimeWith(
		service: unknown,
		byType: unknown[] = [],
	): IAgentRuntime {
		return {
			getService: vi.fn(() => service),
			getServicesByType: vi.fn(() => byType),
		} as unknown as IAgentRuntime;
	}

	it("returns null when nothing looks like a trajectory logger", () => {
		expect(resolveTrajectoryLogger(runtimeWith(null))).toBeNull();
		expect(resolveTrajectoryLogger(runtimeWith({}))).toBeNull();
	});

	it("prefers the candidate that can actually start a trajectory", () => {
		// startTrajectory scores 100; everything else combined scores less, so a
		// rich-but-unstartable logger must never win.
		const rich = {
			startStep: () => "s",
			endTrajectory: () => undefined,
			logLlmCall: () => undefined,
			flushWriteQueue: () => undefined,
			applyReward: () => undefined,
		};
		const starter = { startTrajectory: () => "t" };
		expect(resolveTrajectoryLogger(runtimeWith(rich, [starter]))).toBe(starter);
	});

	it("picks the more complete of two starters", () => {
		const minimal = { startTrajectory: () => "t" };
		const complete = {
			startTrajectory: () => "t",
			startStep: () => "s",
			endTrajectory: () => undefined,
			logLlmCall: () => undefined,
			applyReward: () => undefined,
		};
		expect(resolveTrajectoryLogger(runtimeWith(minimal, [complete]))).toBe(
			complete,
		);
	});

	it("counts EVERY optional capability, not just the headline one", () => {
		// Each optional method carries its own positive weight. Listing the plain
		// starter first means the richer candidate wins only if that specific
		// weight is actually added — a zeroed weight leaves a tie, and a tie
		// keeps the first.
		for (const capability of [
			"startStep",
			"endTrajectory",
			"logLlmCall",
			"flushWriteQueue",
			"applyReward",
		]) {
			const plain = { startTrajectory: () => "t" };
			const richer = {
				startTrajectory: () => "t",
				[capability]: () => undefined,
			};
			expect(resolveTrajectoryLogger(runtimeWith(plain, [richer]))).toBe(
				richer,
			);
		}
	});

	it("keeps the first candidate on a scoring tie", () => {
		const first = { startTrajectory: () => "t" };
		const second = { startTrajectory: () => "t" };
		expect(resolveTrajectoryLogger(runtimeWith(first, [second]))).toBe(first);
	});

	it("does not consider the same instance twice", () => {
		const logger = { startTrajectory: () => "t" };
		expect(resolveTrajectoryLogger(runtimeWith(logger, [logger, logger]))).toBe(
			logger,
		);
	});

	it("still finds a logger registered only by service type", () => {
		const logger = { startTrajectory: () => "t" };
		expect(resolveTrajectoryLogger(runtimeWith(null, [logger]))).toBe(logger);
	});
});

describe("the training-exclusion registry", () => {
	beforeEach(() => {
		__resetTrajectorySourceRegistryForTests();
	});

	afterEach(() => {
		__resetTrajectorySourceRegistryForTests();
	});

	it("reports an unregistered source as includable", () => {
		expect(isExcludedFromTraining("unknown-source")).toBe(false);
	});

	it("round-trips an excluded source", () => {
		registerTrajectorySource("private-corpus", { excludeFromTraining: true });
		expect(isExcludedFromTraining("private-corpus")).toBe(true);
	});

	it("reports a registered but non-excluded source as includable", () => {
		registerTrajectorySource("public-corpus", { excludeFromTraining: false });
		expect(isExcludedFromTraining("public-corpus")).toBe(false);
		registerTrajectorySource("bare", {} as never);
		expect(isExcludedFromTraining("bare")).toBe(false);
	});

	it("trims consistently on both write and read", () => {
		registerTrajectorySource("  spaced  ", { excludeFromTraining: true });
		expect(isExcludedFromTraining("spaced")).toBe(true);
		expect(isExcludedFromTraining("  spaced  ")).toBe(true);
	});

	it("is case-sensitive, so a near-miss name does NOT inherit the exclusion", () => {
		// Fail-open on an unknown name is the documented behavior; this pins that
		// a differently-cased name is genuinely a different source rather than
		// silently matching.
		registerTrajectorySource("Private", { excludeFromTraining: true });
		expect(isExcludedFromTraining("private")).toBe(false);
	});

	it("ignores a blank or non-string registration instead of storing it", () => {
		registerTrajectorySource("", { excludeFromTraining: true });
		registerTrajectorySource("   ", { excludeFromTraining: true });
		registerTrajectorySource(undefined as never, { excludeFromTraining: true });
		expect(isExcludedFromTraining("")).toBe(false);
		expect(isExcludedFromTraining("   ")).toBe(false);
	});

	it("copies the options so a later mutation cannot flip the verdict", () => {
		const opts = { excludeFromTraining: true };
		registerTrajectorySource("snapshot", opts);
		opts.excludeFromTraining = false;
		expect(isExcludedFromTraining("snapshot")).toBe(true);
	});

	it("treats a nullish source name as includable", () => {
		for (const value of [null, undefined, 7 as never]) {
			expect(isExcludedFromTraining(value)).toBe(false);
		}
	});

	it("lets a later registration replace an earlier one", () => {
		registerTrajectorySource("flips", { excludeFromTraining: true });
		registerTrajectorySource("flips", { excludeFromTraining: false });
		expect(isExcludedFromTraining("flips")).toBe(false);
	});
});

describe("trajectory context plumbing used by the guards", () => {
	it("exposes the active step id the guards read", () => {
		expect(getTrajectoryContext()?.trajectoryStepId).toBeUndefined();
		expect(withActiveStep(() => getTrajectoryContext()?.trajectoryStepId)).toBe(
			"step-1",
		);
	});
});

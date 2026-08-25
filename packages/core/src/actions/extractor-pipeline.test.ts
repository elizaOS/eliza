/**
 * Deterministic unit tests for `runExtractorPipeline`. The suite drives the
 * real orchestration (first pass → parse → optional repair → parse) with a
 * queued `useModel` collaborator and real parsers. Failures, non-text
 * responses, falsy-but-non-null parses, and trajectory purpose tags are the
 * observed contracts — not aspirational ones.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import { getTrajectoryContext } from "../trajectory-context.ts";
import { type IAgentRuntime, ModelType } from "../types";
import { runExtractorPipeline } from "./extractor-pipeline.ts";
import { parseJsonModelRecord } from "./json-model-output.ts";

type ModelCall = {
	modelType: string;
	prompt: string;
	purpose: string | undefined;
};

type Report = {
	scope: string;
	error: unknown;
	context: unknown;
};

function parseInteger(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) {
		return null;
	}
	return Number(trimmed);
}

function makeRuntime(handler: (call: ModelCall) => unknown): {
	runtime: IAgentRuntime;
	calls: ModelCall[];
	reports: Report[];
	warns: Array<{ payload: unknown; message: unknown }>;
} {
	const calls: ModelCall[] = [];
	const reports: Report[] = [];
	const warns: Array<{ payload: unknown; message: unknown }> = [];
	const runtime = {
		useModel: async (modelType: string, params: { prompt: string }) => {
			const call: ModelCall = {
				modelType,
				prompt: params.prompt,
				purpose: getTrajectoryContext()?.purpose,
			};
			calls.push(call);
			return handler(call);
		},
		reportError: (scope: string, error: unknown, context?: unknown) => {
			reports.push({ scope, error, context });
		},
		logger: {
			warn: (payload: unknown, message?: unknown) => {
				warns.push({ payload, message });
			},
		},
	} as unknown as IAgentRuntime;
	return { runtime, calls, reports, warns };
}

describe("runExtractorPipeline", () => {
	it("returns the first-pass parse without issuing a repair call", async () => {
		const { runtime, calls, reports } = makeRuntime(() => '{"name":"ada"}');

		const result = await runExtractorPipeline({
			runtime,
			prompt: "extract the name",
			parser: parseJsonModelRecord<{ name: string }>,
			buildRepairPrompt: (raw) => `repair: ${raw}`,
		});

		expect(result).toEqual({
			parsed: { name: "ada" },
			raw: '{"name":"ada"}',
			repaired: false,
		});
		expect(calls).toEqual([
			{
				modelType: ModelType.TEXT_LARGE,
				prompt: "extract the name",
				purpose: "lifeops-extractor-first-pass",
			},
		]);
		expect(reports).toEqual([]);
	});

	it("defaults modelType to TEXT_LARGE when omitted", async () => {
		const { runtime, calls } = makeRuntime(() => "7");

		await runExtractorPipeline({
			runtime,
			prompt: "n",
			parser: parseInteger,
		});

		expect(calls[0]?.modelType).toBe(ModelType.TEXT_LARGE);
		expect(calls[0]?.modelType).toBe("TEXT_LARGE");
	});

	it("forwards an explicit modelType to the first pass", async () => {
		const { runtime, calls } = makeRuntime(() => "1");

		await runExtractorPipeline({
			runtime,
			prompt: "n",
			parser: parseInteger,
			modelType: ModelType.TEXT_SMALL,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.modelType).toBe(ModelType.TEXT_SMALL);
	});

	it("returns a parse miss without repair when buildRepairPrompt is omitted", async () => {
		const { runtime, calls } = makeRuntime(() => "not-json");

		const result = await runExtractorPipeline({
			runtime,
			prompt: "extract",
			parser: parseJsonModelRecord,
		});

		expect(result).toEqual({
			parsed: null,
			raw: "not-json",
			repaired: false,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.prompt).toBe("extract");
	});

	it("does not treat a missing buildRepairPrompt the same as an empty repair prompt", async () => {
		const { runtime, calls } = makeRuntime(() => "x");

		const without = await runExtractorPipeline({
			runtime,
			prompt: "p",
			parser: () => null,
		});
		expect(without.repaired).toBe(false);
		expect(calls).toHaveLength(1);

		const { runtime: withEmpty, calls: emptyCalls } = makeRuntime(() => "x");
		const withEmptyPrompt = await runExtractorPipeline({
			runtime: withEmpty,
			prompt: "p",
			parser: () => null,
			buildRepairPrompt: () => "",
		});
		expect(withEmptyPrompt.repaired).toBe(true);
		expect(emptyCalls).toHaveLength(2);
		expect(emptyCalls[1]?.prompt).toBe("");
	});

	it("issues one repair pass and returns the repaired parse", async () => {
		const outputs = ["not-json", '{"name":"grace"}'];
		const { runtime, calls } = makeRuntime(() => {
			const next = outputs.shift();
			if (next === undefined) {
				throw new Error("unexpected extra useModel call");
			}
			return next;
		});

		const result = await runExtractorPipeline({
			runtime,
			prompt: "extract the name",
			parser: parseJsonModelRecord<{ name: string }>,
			buildRepairPrompt: (raw) => `fix ${raw}`,
			modelType: ModelType.TEXT_MEDIUM,
		});

		expect(result).toEqual({
			parsed: { name: "grace" },
			raw: '{"name":"grace"}',
			repaired: true,
		});
		expect(calls).toEqual([
			{
				modelType: ModelType.TEXT_MEDIUM,
				prompt: "extract the name",
				purpose: "lifeops-extractor-first-pass",
			},
			{
				modelType: ModelType.TEXT_MEDIUM,
				prompt: "fix not-json",
				purpose: "lifeops-extractor-repair-pass",
			},
		]);
	});

	it("returns repaired:true with parsed:null when the repair pass also misses", async () => {
		const outputs = ["first-miss", "still-miss"];
		const { runtime } = makeRuntime(() => outputs.shift() ?? "overflow");

		const result = await runExtractorPipeline({
			runtime,
			prompt: "extract",
			parser: parseJsonModelRecord,
			buildRepairPrompt: (raw) => `retry ${raw}`,
		});

		expect(result).toEqual({
			parsed: null,
			raw: "still-miss",
			repaired: true,
		});
	});

	it("hands the exact first-pass raw string to buildRepairPrompt", async () => {
		const seen: string[] = [];
		const outputs = ["  {bad}  ", '{"ok":true}'];
		const { runtime } = makeRuntime(() => outputs.shift() ?? "");

		await runExtractorPipeline({
			runtime,
			prompt: "p",
			parser: parseJsonModelRecord,
			buildRepairPrompt: (raw) => {
				seen.push(raw);
				return `repair(${raw})`;
			},
		});

		expect(seen).toEqual(["  {bad}  "]);
	});

	it("treats a parsed 0 as success and skips repair", async () => {
		const { runtime, calls } = makeRuntime(() => "0");

		const result = await runExtractorPipeline({
			runtime,
			prompt: "p",
			parser: parseInteger,
			buildRepairPrompt: () => "must-not-run",
		});

		expect(result).toEqual({ parsed: 0, raw: "0", repaired: false });
		expect(calls).toHaveLength(1);
	});

	it("treats a parsed false as success and skips repair", async () => {
		const { runtime, calls } = makeRuntime(() => "false");

		const result = await runExtractorPipeline({
			runtime,
			prompt: "p",
			parser: (raw) => (raw === "false" ? false : null),
			buildRepairPrompt: () => "must-not-run",
		});

		expect(result).toEqual({ parsed: false, raw: "false", repaired: false });
		expect(calls).toHaveLength(1);
	});

	it("treats a parsed empty string as success and skips repair", async () => {
		const { runtime, calls } = makeRuntime(() => "present");

		const result = await runExtractorPipeline({
			runtime,
			prompt: "p",
			parser: (raw) => (raw.length > 0 ? "" : null),
			buildRepairPrompt: () => "must-not-run",
		});

		expect(result).toEqual({
			parsed: "",
			raw: "present",
			repaired: false,
		});
		expect(calls).toHaveLength(1);
	});

	it("accepts an empty-string model response and still runs the parser", async () => {
		const seen: string[] = [];
		const { runtime } = makeRuntime(() => "");

		const result = await runExtractorPipeline({
			runtime,
			prompt: "p",
			parser: (raw) => {
				seen.push(raw);
				return null;
			},
		});

		expect(seen).toEqual([""]);
		expect(result).toEqual({ parsed: null, raw: "", repaired: false });
	});

	it("throws EXTRACTOR_NON_TEXT_RESPONSE for a numeric first-pass result", async () => {
		const { runtime, calls, reports, warns } = makeRuntime(() => 42);

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
			}),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "EXTRACTOR_NON_TEXT_RESPONSE",
			message: "Extractor model returned a non-text response",
			context: { responseType: "number" },
		});

		expect(calls).toHaveLength(1);
		expect(reports).toHaveLength(1);
		expect(reports[0]?.scope).toBe("ExtractorPipeline.model");
		expect(reports[0]?.context).toEqual({ modelType: ModelType.TEXT_LARGE });
		expect(reports[0]?.error).toBeInstanceOf(ElizaError);
		expect(warns).toEqual([
			{
				payload: {
					src: "lifeops:extractor-pipeline",
					error: "Extractor model returned a non-text response",
				},
				message: "Extractor pipeline model call failed",
			},
		]);
	});

	it("records responseType object when the first-pass result is null", async () => {
		const { runtime, reports } = makeRuntime(() => null);

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
			}),
		).rejects.toMatchObject({
			code: "EXTRACTOR_NON_TEXT_RESPONSE",
			context: { responseType: "object" },
		});

		expect(reports).toHaveLength(1);
		expect(reports[0]?.error).toBeInstanceOf(ElizaError);
		expect(reports[0]?.error).toMatchObject({
			code: "EXTRACTOR_NON_TEXT_RESPONSE",
			context: { responseType: "object" },
		});
	});

	it("records responseType undefined when the first-pass result is undefined", async () => {
		const { runtime } = makeRuntime(() => undefined);

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
			}),
		).rejects.toMatchObject({
			code: "EXTRACTOR_NON_TEXT_RESPONSE",
			context: { responseType: "undefined" },
		});
	});

	it("throws EXTRACTOR_NON_TEXT_RESPONSE for a non-text repair result", async () => {
		const outputs: unknown[] = ["not-an-int", { text: "3" }];
		const { runtime, calls, reports } = makeRuntime(() => outputs.shift());

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
				buildRepairPrompt: () => "repair-me",
			}),
		).rejects.toMatchObject({
			code: "EXTRACTOR_NON_TEXT_RESPONSE",
			context: { responseType: "object" },
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]?.prompt).toBe("repair-me");
		expect(reports[0]?.scope).toBe("ExtractorPipeline.model");
	});

	it("reports and rethrows a first-pass useModel failure without a repair attempt", async () => {
		const boom = new Error("upstream 503");
		const { runtime, calls, reports, warns } = makeRuntime(() => {
			throw boom;
		});

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
				buildRepairPrompt: () => "must-not-run",
			}),
		).rejects.toBe(boom);

		expect(calls).toHaveLength(1);
		expect(reports).toEqual([
			{
				scope: "ExtractorPipeline.model",
				error: boom,
				context: { modelType: ModelType.TEXT_LARGE },
			},
		]);
		expect(warns[0]?.payload).toEqual({
			src: "lifeops:extractor-pipeline",
			error: "upstream 503",
		});
	});

	it("reports and rethrows a repair-pass useModel failure", async () => {
		const boom = new Error("repair provider down");
		let pass = 0;
		const { runtime, calls, reports } = makeRuntime(() => {
			pass += 1;
			if (pass === 1) {
				return "not-an-int";
			}
			throw boom;
		});

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
				buildRepairPrompt: () => "repair",
				modelType: ModelType.TEXT_NANO,
			}),
		).rejects.toBe(boom);

		expect(calls).toHaveLength(2);
		expect(reports).toEqual([
			{
				scope: "ExtractorPipeline.model",
				error: boom,
				context: { modelType: ModelType.TEXT_NANO },
			},
		]);
	});

	it("stringifies a non-Error throw in the warn payload and rethrows it", async () => {
		const { runtime, reports, warns } = makeRuntime(() => {
			throw "bare-string-failure";
		});

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: parseInteger,
			}),
		).rejects.toBe("bare-string-failure");

		expect(reports[0]?.error).toBe("bare-string-failure");
		expect(warns[0]?.payload).toEqual({
			src: "lifeops:extractor-pipeline",
			error: "bare-string-failure",
		});
	});

	it("reports a parser throw as ExtractorPipeline.model and does not repair", async () => {
		const parserError = new Error("parser exploded");
		const { runtime, calls, reports } = makeRuntime(() => "12");

		await expect(
			runExtractorPipeline({
				runtime,
				prompt: "p",
				parser: () => {
					throw parserError;
				},
				buildRepairPrompt: () => "must-not-run",
			}),
		).rejects.toBe(parserError);

		expect(calls).toHaveLength(1);
		expect(reports).toEqual([
			{
				scope: "ExtractorPipeline.model",
				error: parserError,
				context: { modelType: ModelType.TEXT_LARGE },
			},
		]);
	});
});

/**
 * DSPy-style Predict module (native TS).
 *
 * Predict is the smallest composable LM module:
 *   1. Render a Signature into a system + user prompt.
 *   2. Prepend few-shot demonstrations (if any).
 *   3. Call the LM adapter.
 *   4. Parse the LM's response into typed output fields.
 *
 * `Predict.forward()` returns `{output, usage, trace}` so optimizer code can
 * inspect what was sent + what came back without re-running the LM.
 */

import type { Example } from "./examples.js";
import type {
	GenerateResult,
	LanguageModelAdapter,
	UsageInfo,
} from "./lm-adapter.js";
import type { Signature, SignatureSpec } from "./signature.js";

export interface PredictOpts<
	I extends Record<string, unknown> = Record<string, unknown>,
	O extends Record<string, unknown> = Record<string, unknown>,
> {
	signature: Signature<I, O>;
	lm: LanguageModelAdapter;
	demonstrations?: Example[];
	temperature?: number;
	maxTokens?: number;
	/** Override instructions without rebuilding the signature (used by COPRO). */
	instructionsOverride?: string;
}

export interface PredictTrace {
	system: string;
	user: string;
	rawResponse: string;
	demonstrationCount: number;
}

export interface PredictResult<O extends Record<string, unknown> = Record<string, unknown>> {
	output: O;
	usage: UsageInfo;
	trace: PredictTrace;
}

export class Predict<
	I extends Record<string, unknown> = Record<string, unknown>,
	O extends Record<string, unknown> = Record<string, unknown>,
> {
	constructor(private readonly opts: PredictOpts<I, O>) {}

	get signature(): Signature<I, O> {
		return this.opts.signature;
	}

	get demonstrations(): Example[] {
		return this.opts.demonstrations ?? [];
	}

	async forward(input: I): Promise<PredictResult<O>> {
		const rendered = this.opts.signature.render(input, {
			instructionsOverride: this.opts.instructionsOverride,
		});
		const demoBlock = renderDemonstrationsBlock(
			this.opts.signature.spec,
			this.opts.demonstrations ?? [],
		);
		const system = demoBlock
			? `${rendered.system}\n\n${demoBlock}`
			: rendered.system;
		const result: GenerateResult = await this.opts.lm.generate({
			system,
			messages: [{ role: "user", content: rendered.user }],
			temperature: this.opts.temperature ?? 0,
			maxTokens: this.opts.maxTokens,
		});
		// `signature.parse` is the LM-response boundary: it throws
		// `SignatureParseError` on malformed output. No silent fallback — the
		// optimizer scoring loop catches the throw and scores 0 (documented
		// behavior in `dspy-bootstrap-fewshot.ts` / `dspy-copro.ts` / `dspy-mipro.ts`).
		const output = this.opts.signature.parse(result.text);
		return {
			output,
			usage: result.usage,
			trace: {
				system,
				user: rendered.user,
				rawResponse: result.text,
				demonstrationCount: this.opts.demonstrations?.length ?? 0,
			},
		};
	}
}

/**
 * Render a `Demonstrations:` block in the same shape the signature uses for
 * a real turn. Used by both Predict and the bootstrap-fewshot optimizer so
 * the few-shot format is one canonical thing.
 */
export function renderDemonstrationsBlock(
	spec: SignatureSpec,
	demos: Example[],
): string {
	if (demos.length === 0) return "";
	const lines: string[] = ["Demonstrations:", ""];
	for (let i = 0; i < demos.length; i += 1) {
		const demo = demos[i];
		if (!demo) continue;
		lines.push(`Example ${i + 1}:`);
		for (const field of spec.inputs) {
			const value = demo.inputs[field.name];
			if (value === undefined || value === null) continue;
			lines.push(`${field.name}: ${renderForDemo(value)}`);
		}
		for (const field of spec.outputs) {
			const value = demo.outputs[field.name];
			if (value === undefined || value === null) continue;
			lines.push(`${field.name}: ${renderForDemo(value)}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function renderForDemo(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

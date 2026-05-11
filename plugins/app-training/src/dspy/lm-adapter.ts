/**
 * DSPy-style LanguageModelAdapter — abstracts Cerebras / Anthropic / OpenAI /
 * mock implementations behind one minimal interface so Predict/CoT/optimizers
 * stay provider-agnostic.
 *
 * The existing `LlmAdapter` (in `optimizers/types.ts`) is intentionally narrow
 * (`complete()` → string) for the legacy three optimizers. The DSPy modules
 * need slightly richer semantics: a message-array interface plus usage
 * telemetry. We bridge to the legacy adapter via `legacyAdapterToLm()` for
 * call-sites that still hold an `LlmAdapter`.
 */

import type { LlmAdapter } from "../optimizers/types.js";

export interface UsageInfo {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	/** Provider-specific cache fields are surfaced verbatim under `cache`. */
	cache?: Record<string, number>;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface GenerateArgs {
	system: string;
	messages: ChatMessage[];
	temperature?: number;
	maxTokens?: number;
	stop?: string[];
}

export interface GenerateResult {
	text: string;
	usage: UsageInfo;
}

export interface LanguageModelAdapter {
	name: string;
	generate(args: GenerateArgs): Promise<GenerateResult>;
}

/**
 * Lift a legacy `LlmAdapter` (which only exposes `complete({system,user})`)
 * into the DSPy `LanguageModelAdapter` shape. We collapse the message array
 * by concatenating non-system turns with role tags so the legacy adapter sees
 * a single composed user prompt — adequate for our scoring loop, which uses
 * single-turn signatures only.
 */
export function legacyAdapterToLm(
	legacy: LlmAdapter,
	name = "legacy",
): LanguageModelAdapter {
	return {
		name,
		async generate(args) {
			const composed = args.messages
				.map((m) =>
					m.role === "user" ? m.content : `[${m.role}]\n${m.content}`,
				)
				.join("\n\n");
			const text = await legacy.complete({
				system: args.system,
				user: composed,
				temperature: args.temperature,
				maxTokens: args.maxTokens,
			});
			return { text, usage: {} };
		},
	};
}

/**
 * MockAdapter — deterministic, no-network LM for tests.
 *
 * The adapter accepts a list of `(systemContains, userContains) → text`
 * rules and returns the first matching response. The default fallback echoes
 * the user message so even unconfigured tests get a deterministic string.
 */
export interface MockRule {
	system?: string | RegExp;
	user?: string | RegExp;
	response: string;
}

export interface MockAdapterOptions {
	rules?: MockRule[];
	defaultResponse?: string;
	/** Optional usage stub returned with every response. */
	usage?: UsageInfo;
	/** Records every call for assertion in tests. */
	log?: GenerateArgs[];
}

export class MockAdapter implements LanguageModelAdapter {
	readonly name = "mock";
	private readonly rules: MockRule[];
	private readonly defaultResponse: string;
	private readonly usage: UsageInfo;
	private readonly log?: GenerateArgs[];
	private callCount = 0;

	constructor(options: MockAdapterOptions = {}) {
		this.rules = options.rules ?? [];
		this.defaultResponse = options.defaultResponse ?? "";
		this.usage = options.usage ?? {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		};
		this.log = options.log;
	}

	get calls(): number {
		return this.callCount;
	}

	async generate(args: GenerateArgs): Promise<GenerateResult> {
		this.callCount += 1;
		this.log?.push(args);
		const userContent = args.messages
			.filter((m) => m.role === "user")
			.map((m) => m.content)
			.join("\n");
		for (const rule of this.rules) {
			if (rule.system && !matches(rule.system, args.system)) continue;
			if (rule.user && !matches(rule.user, userContent)) continue;
			return { text: rule.response, usage: this.usage };
		}
		return {
			text: this.defaultResponse || userContent,
			usage: this.usage,
		};
	}
}

function matches(needle: string | RegExp, haystack: string): boolean {
	if (typeof needle === "string") return haystack.includes(needle);
	return needle.test(haystack);
}

/**
 * Cerebras adapter that routes through the existing
 * `getTrainingUseModelAdapter()` helper (`lifeops-eval-model.ts`). The helper
 * already implements gpt-oss-120b auth, reasoning-effort hints, and retry
 * logic, so we delegate rather than re-implementing the HTTP client.
 *
 * The constructor takes the `useModel` callable so this module stays free of
 * a hard import on `app-lifeops` (it lives in a sibling plugin). Callers
 * resolve the helper through a dynamic import and inject it here.
 */
export interface UseModelLike {
	(input: {
		prompt: string;
		systemPrompt?: string;
		temperature?: number;
		maxTokens?: number;
	}): Promise<string>;
}

export class CerebrasAdapter implements LanguageModelAdapter {
	readonly name = "cerebras";

	constructor(private readonly useModel: UseModelLike) {}

	async generate(args: GenerateArgs): Promise<GenerateResult> {
		const userContent = args.messages
			.filter((m) => m.role !== "system")
			.map((m) =>
				m.role === "user" ? m.content : `[${m.role}]\n${m.content}`,
			)
			.join("\n\n");
		const text = await this.useModel({
			prompt: userContent,
			systemPrompt: args.system,
			temperature: args.temperature,
			maxTokens: args.maxTokens,
		});
		// gpt-oss-120b does not expose per-call cache fields through the existing
		// helper, so usage stays empty here. The helper-level cache hit-rate
		// counters live in `lifeops-eval-model.ts` and surface elsewhere.
		return { text, usage: {} };
	}
}

/**
 * Fixture-driven model provider for real-runtime tests.
 *
 * The plugin participates in normal model dispatch alongside production providers,
 * but returns only caller-declared responses. Unmatched or ambiguous calls fail so
 * deterministic tests cannot pass by inventing a plausible model decision.
 */
import { createHash } from "node:crypto";
import type {
	GenerateTextParams,
	GenerateTextResult,
	ModelTypeName,
} from "../types/model";
import { ModelType } from "../types/model";
import type { Plugin } from "../types/plugin";
import type { JsonValue } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";

export interface DeterministicModelCall {
	modelType: ModelTypeName;
	params: GenerateTextParams;
	latestUserText: string;
	toolNames: string[];
}

export type DeterministicModelResponse =
	| string
	| GenerateTextResult
	| Record<string, JsonValue>;

export type DeterministicTextMatcher =
	| string
	| RegExp
	| ((value: string, call: DeterministicModelCall) => boolean);

export type DeterministicSchemaMatcher =
	| JsonValue
	| Record<string, unknown>
	| ((schema: unknown, call: DeterministicModelCall) => boolean);

export interface DeterministicModelFixtureMatch {
	modelType?: ModelTypeName | ModelTypeName[];
	input?: DeterministicTextMatcher;
	prompt?: DeterministicTextMatcher;
	toolName?: DeterministicTextMatcher;
	toolNames?: string[];
	responseSchema?: DeterministicSchemaMatcher;
	toolSchema?: DeterministicSchemaMatcher;
}

export interface DeterministicModelFixture {
	name: string;
	match?:
		| DeterministicModelFixtureMatch
		| ((call: DeterministicModelCall) => boolean);
	response?:
		| DeterministicModelResponse
		| ((call: DeterministicModelCall) => DeterministicModelResponse);
	resolve?: (
		call: DeterministicModelCall,
	) => DeterministicModelResponse | null | undefined;
	required?: boolean;
	times?: number | "any" | { min?: number; max?: number };
	behavior?: DeterministicModelFixtureBehavior;
}

export interface DeterministicModelFixtureBehavior {
	/** Delay before returning or failing. The delay is abort-aware. */
	latencyMs?: number;
	/** Stream this fixture with its own cadence instead of the plugin default. */
	stream?: { chunkSize: number; intervalMs: number };
	/** Throw the declared provider-shaped failure after matching the fixture. */
	error?: { message: string; code?: string; status?: number; type?: string };
	/** Keep the request pending until its AbortSignal is cancelled. */
	waitForAbort?: boolean;
}

export interface DeterministicModelCallDiagnostic {
	modelType: ModelTypeName;
	latestUserTextFingerprint: string;
	promptFingerprint: string;
	latestUserTextLength: number;
	promptLength: number;
	toolNames: string[];
	matchedFixtureName?: string;
	responseSchemaFingerprint?: string;
	matchingReason?: string;
	availableFixtureNames: string[];
}

export interface DeterministicModelFixtureDiagnostic {
	name: string;
	consumed: number;
	min: number;
	max: number | "unbounded";
	required: boolean;
}

export interface DeterministicModelDiagnostics {
	scope?: DeterministicModelFixtureScope;
	calls: DeterministicModelCallDiagnostic[];
	fixtures: DeterministicModelFixtureDiagnostic[];
	unexpectedCalls: DeterministicModelCallDiagnostic[];
}

/** Correlates one isolated fixture registry with a scenario attempt/world. */
export interface DeterministicModelFixtureScope {
	scenarioId: string;
	attemptId: string;
	/** Reserved adapter seam for the canonical synthetic-world contract (#22898). */
	worldId?: string;
}

export interface DeterministicModelFixtureResolution {
	fixtureName: string;
	response: string;
	rawResponse: DeterministicModelResponse;
	behavior?: DeterministicModelFixtureBehavior;
}

export interface DeterministicModelFixtureRegistry {
	register(...fixtures: DeterministicModelFixture[]): void;
	resolve(call: DeterministicModelCall): DeterministicModelFixtureResolution;
	assertConsumed(): void;
	clear(): void;
	diagnostics(): DeterministicModelDiagnostics;
	resetConsumption(): void;
	beginAttempt(
		scope: DeterministicModelFixtureScope,
		fixtures?: DeterministicModelFixture[],
	): void;
}

export interface DeterministicModelPlugin extends Plugin {
	fixtures: DeterministicModelFixtureRegistry;
	assertFixturesConsumed(): void;
	getFixtureDiagnostics(): DeterministicModelDiagnostics;
}

export interface DeterministicModelPluginOptions {
	fixtures?: DeterministicModelFixture[];
	fixtureRegistry?: DeterministicModelFixtureRegistry;
	priority?: number;
	resolve?: (
		call: DeterministicModelCall,
	) => DeterministicModelResponse | null | undefined;
	stream?: {
		chunkSize: number;
		intervalMs: number;
		modelTypes?: ModelTypeName[];
	};
}

interface RegisteredFixture extends DeterministicModelFixture {
	consumed: number;
	min: number;
	max: number;
}

class DeterministicModelMatchError extends Error {
	constructor(
		readonly kind: "unmatched" | "ambiguous" | "over-consumed",
		message: string,
	) {
		super(message);
		this.name = "DeterministicModelMatchError";
	}
}

const TEXT_MODEL_TYPES = [
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.TEXT_REASONING_SMALL,
	ModelType.TEXT_REASONING_LARGE,
	ModelType.TEXT_COMPLETION,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
] as const;

export function createDeterministicModelFixtureRegistry(
	fixtures: DeterministicModelFixture[] = [],
): DeterministicModelFixtureRegistry {
	const entries: RegisteredFixture[] = [];
	const calls: DeterministicModelCallDiagnostic[] = [];
	const unexpectedCalls: DeterministicModelCallDiagnostic[] = [];
	let scope: DeterministicModelFixtureScope | undefined;

	const registry: DeterministicModelFixtureRegistry = {
		register(...next): void {
			for (const fixture of next) entries.push(registerFixture(fixture));
		},
		resolve(call): DeterministicModelFixtureResolution {
			return resolveRegisteredFixture(entries, calls, unexpectedCalls, call);
		},
		assertConsumed(): void {
			const unused = entries.filter(
				(fixture) => fixture.consumed < fixture.min,
			);
			if (unused.length === 0) return;
			throw new Error(
				`deterministic model fixtures were not consumed: ${JSON.stringify(unused.map(fixtureDiagnostic))}`,
			);
		},
		clear(): void {
			entries.length = 0;
			calls.length = 0;
			unexpectedCalls.length = 0;
			scope = undefined;
		},
		diagnostics: () => ({
			...(scope ? { scope: { ...scope } } : {}),
			calls: [...calls],
			fixtures: entries.map(fixtureDiagnostic),
			unexpectedCalls: [...unexpectedCalls],
		}),
		resetConsumption(): void {
			calls.length = 0;
			unexpectedCalls.length = 0;
			for (const fixture of entries) fixture.consumed = 0;
		},
		beginAttempt(nextScope, nextFixtures = []): void {
			registry.clear();
			scope = { ...nextScope };
			registry.register(...nextFixtures);
		},
	};

	registry.register(...fixtures);
	registryUnmatchedRollbacks.set(registry, () => {
		unexpectedCalls.pop();
	});
	return registry;
}

const registryUnmatchedRollbacks = new WeakMap<
	DeterministicModelFixtureRegistry,
	() => void
>();

export function createDeterministicModelPlugin(
	options: DeterministicModelPluginOptions = {},
): DeterministicModelPlugin {
	const fixtures =
		options.fixtureRegistry ??
		createDeterministicModelFixtureRegistry(options.fixtures);
	if (options.fixtureRegistry && options.fixtures?.length) {
		fixtures.register(...options.fixtures);
	}

	const models: NonNullable<Plugin["models"]> = {};
	for (const modelType of TEXT_MODEL_TYPES) {
		models[modelType] = (async (
			_runtime: IAgentRuntime,
			params: GenerateTextParams,
		) => {
			const call = buildCall(modelType, params);
			let resolved: DeterministicModelFixtureResolution;
			try {
				resolved = fixtures.resolve(call);
			} catch (error) {
				if (
					!(error instanceof DeterministicModelMatchError) ||
					error.kind !== "unmatched" ||
					!options.resolve
				)
					throw error;
				const fallbackResponse = options.resolve(call);
				if (fallbackResponse === null || fallbackResponse === undefined)
					throw error;
				registryUnmatchedRollbacks.get(fixtures)?.();
				resolved = {
					fixtureName: "explicit-fallback-resolver",
					response: normalizeResponse(fallbackResponse),
					rawResponse: fallbackResponse,
				};
			}
			await applyDeterministicModelFixtureBehavior(
				resolved.behavior,
				params.signal,
			);
			const stream = resolved.behavior?.stream ?? options.stream;
			await streamResponse(params, resolved.response, stream, modelType);
			return resolved.response;
		}) as never;
	}

	return {
		name: "deterministic-model-provider",
		description: "Fixture-driven model provider for real-runtime tests.",
		priority: options.priority ?? 1_000,
		models,
		...(options.stream
			? {
					modelMetadata: Object.fromEntries(
						TEXT_MODEL_TYPES.filter(
							(type) =>
								!options.stream?.modelTypes ||
								options.stream.modelTypes.includes(type),
						).map((type) => [type, { streamable: true }]),
					),
				}
			: {}),
		fixtures,
		assertFixturesConsumed: () => fixtures.assertConsumed(),
		getFixtureDiagnostics: () => fixtures.diagnostics(),
	};
}

function resolveRegisteredFixture(
	entries: RegisteredFixture[],
	calls: DeterministicModelCallDiagnostic[],
	unexpectedCalls: DeterministicModelCallDiagnostic[],
	call: DeterministicModelCall,
): DeterministicModelFixtureResolution {
	const diagnostic = callDiagnostic(call);
	diagnostic.availableFixtureNames = entries.map((fixture) => fixture.name);
	calls.push(diagnostic);
	const allMatching = entries.filter((fixture) =>
		matchesFixture(fixture, call),
	);
	const matching = allMatching.filter(
		(fixture) => fixture.consumed < fixture.max,
	);
	if (matching.length !== 1) {
		unexpectedCalls.push(diagnostic);
		const reason =
			matching.length === 0 && allMatching.length > 0
				? "all matching fixtures were over-consumed"
				: matching.length === 0
					? "no fixture matched"
					: "multiple fixtures matched";
		diagnostic.matchingReason = reason;
		throw new DeterministicModelMatchError(
			matching.length === 0
				? allMatching.length > 0
					? "over-consumed"
					: "unmatched"
				: "ambiguous",
			`deterministic model call failed: ${reason}: ${JSON.stringify({ call: diagnostic, fixtures: (matching.length > 0 ? matching : allMatching).map((fixture) => fixture.name) })}`,
		);
	}
	const fixture = matching[0];
	const rawResponse = resolveFixtureResponse(fixture, call);
	if (rawResponse === null || rawResponse === undefined) {
		unexpectedCalls.push(diagnostic);
		throw new Error(
			`deterministic model fixture "${fixture.name}" did not return a response`,
		);
	}
	fixture.consumed += 1;
	diagnostic.matchedFixtureName = fixture.name;
	diagnostic.matchingReason = "exactly one eligible fixture matched";
	return {
		fixtureName: fixture.name,
		response: normalizeResponse(rawResponse),
		rawResponse,
		behavior: fixture.behavior,
	};
}

function registerFixture(
	fixture: DeterministicModelFixture,
): RegisteredFixture {
	if (!fixture.name.trim())
		throw new Error("deterministic model fixture name is required");
	if (fixture.response === undefined && fixture.resolve === undefined) {
		if (!fixture.behavior?.error && !fixture.behavior?.waitForAbort) {
			throw new Error(
				`deterministic model fixture "${fixture.name}" must define response, resolve, error, or waitForAbort`,
			);
		}
	}
	validateBehavior(fixture);
	const bounds = fixtureBounds(fixture);
	return { ...fixture, ...bounds, consumed: 0 };
}

function fixtureBounds(fixture: DeterministicModelFixture): {
	min: number;
	max: number;
} {
	if (fixture.times === "any") return { min: 0, max: Number.POSITIVE_INFINITY };
	if (typeof fixture.times === "number") {
		if (!Number.isSafeInteger(fixture.times) || fixture.times < 0) {
			throw new Error(`fixture "${fixture.name}" has invalid times`);
		}
		return { min: fixture.times, max: fixture.times };
	}
	const min = fixture.times?.min ?? (fixture.required === false ? 0 : 1);
	const max = fixture.times?.max ?? Number.POSITIVE_INFINITY;
	if (min < 0 || max < min)
		throw new Error(`fixture "${fixture.name}" has invalid bounds`);
	return { min, max };
}

function fixtureDiagnostic(
	fixture: RegisteredFixture,
): DeterministicModelFixtureDiagnostic {
	return {
		name: fixture.name,
		consumed: fixture.consumed,
		min: fixture.min,
		max: Number.isFinite(fixture.max) ? fixture.max : "unbounded",
		required: fixture.min > 0,
	};
}

function matchesFixture(
	fixture: RegisteredFixture,
	call: DeterministicModelCall,
): boolean {
	if (!fixture.match) return true;
	if (typeof fixture.match === "function") return fixture.match(call);
	const match = fixture.match;
	if (match.modelType) {
		const expected = Array.isArray(match.modelType)
			? match.modelType
			: [match.modelType];
		if (!expected.includes(call.modelType)) return false;
	}
	if (
		match.input &&
		!matchesText(
			match.input,
			call.latestUserText || call.params.prompt || "",
			call,
		)
	)
		return false;
	if (
		match.prompt &&
		!matchesText(match.prompt, call.params.prompt ?? "", call)
	)
		return false;
	if (
		match.toolName &&
		!call.toolNames.some((name) =>
			matchesText(match.toolName as DeterministicTextMatcher, name, call),
		)
	)
		return false;
	if (
		match.toolNames &&
		stableStringify([...match.toolNames].sort()) !==
			stableStringify([...call.toolNames].sort())
	)
		return false;
	if (
		match.responseSchema !== undefined &&
		!matchesSchema(match.responseSchema, call.params.responseSchema, call)
	)
		return false;
	if (match.toolSchema !== undefined) {
		const tools = (call.params.tools ?? []).filter((tool) =>
			match.toolName ? matchesText(match.toolName, tool.name, call) : true,
		);
		if (
			!tools.some((tool) =>
				matchesSchema(
					match.toolSchema as DeterministicSchemaMatcher,
					tool.parameters,
					call,
				),
			)
		)
			return false;
	}
	return true;
}

function matchesText(
	matcher: DeterministicTextMatcher,
	value: string,
	call: DeterministicModelCall,
): boolean {
	if (typeof matcher === "string") return matcher === value;
	if (matcher instanceof RegExp) {
		// Global/sticky regexes mutate lastIndex on test(); reset on both sides so
		// repeated attempts and parallel registries observe identical matching.
		matcher.lastIndex = 0;
		const matched = matcher.test(value);
		matcher.lastIndex = 0;
		return matched;
	}
	return matcher(value, call);
}

function matchesSchema(
	matcher: DeterministicSchemaMatcher,
	value: unknown,
	call: DeterministicModelCall,
): boolean {
	if (typeof matcher === "function") return matcher(value, call);
	return stableStringify(matcher) === stableStringify(value);
}

function resolveFixtureResponse(
	fixture: RegisteredFixture,
	call: DeterministicModelCall,
): DeterministicModelResponse | null | undefined {
	if (fixture.resolve) return fixture.resolve(call);
	return typeof fixture.response === "function"
		? fixture.response(call)
		: (fixture.response ?? "");
}

function normalizeResponse(response: DeterministicModelResponse): string {
	return typeof response === "string" ? response : JSON.stringify(response);
}

function buildCall(
	modelType: ModelTypeName,
	params: GenerateTextParams,
): DeterministicModelCall {
	return {
		modelType,
		params,
		latestUserText: latestUserText(params),
		toolNames: (params.tools ?? []).map((tool) => tool.name),
	};
}

function callDiagnostic(
	call: DeterministicModelCall,
): DeterministicModelCallDiagnostic {
	return {
		modelType: call.modelType,
		latestUserTextFingerprint: fingerprint(call.latestUserText),
		promptFingerprint: fingerprint(call.params.prompt ?? ""),
		latestUserTextLength: call.latestUserText.length,
		promptLength: (call.params.prompt ?? "").length,
		toolNames: call.toolNames,
		responseSchemaFingerprint:
			call.params.responseSchema === undefined
				? undefined
				: fingerprint(stableStringify(call.params.responseSchema)),
		availableFixtureNames: [],
	};
}

function fingerprint(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function latestUserText(params: GenerateTextParams): string {
	const messages = params.messages;
	if (Array.isArray(messages)) {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "user") return contentToText(message.content);
		}
	}
	return extractPromptUserMessage(params.prompt ?? "");
}

function extractPromptUserMessage(prompt: string): string {
	const markers = ["message:user:\n", "User:\n", "USER:\n"];
	for (const marker of markers) {
		const index = prompt.lastIndexOf(marker);
		if (index >= 0) return prompt.slice(index + marker.length).trim();
	}
	return prompt.trim();
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? String(value);
}

function validateBehavior(fixture: DeterministicModelFixture): void {
	const behavior = fixture.behavior;
	if (!behavior) return;
	if (
		behavior.latencyMs !== undefined &&
		(!Number.isSafeInteger(behavior.latencyMs) || behavior.latencyMs < 0)
	) {
		throw new Error(`fixture "${fixture.name}" has invalid latencyMs`);
	}
	if (behavior.stream) {
		if (
			!Number.isSafeInteger(behavior.stream.chunkSize) ||
			behavior.stream.chunkSize <= 0 ||
			!Number.isSafeInteger(behavior.stream.intervalMs) ||
			behavior.stream.intervalMs < 0
		) {
			throw new Error(`fixture "${fixture.name}" has invalid stream behavior`);
		}
	}
}

export async function applyDeterministicModelFixtureBehavior(
	behavior: DeterministicModelFixtureBehavior | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!behavior) return;
	if (behavior.waitForAbort) {
		await waitForAbort(signal);
	}
	if ((behavior.latencyMs ?? 0) > 0) {
		await abortableDelay(behavior.latencyMs ?? 0, signal);
	}
	if (behavior.error) {
		const error = new Error(behavior.error.message) as Error & {
			code?: string;
			status?: number;
			type?: string;
		};
		error.name = "DeterministicModelFixtureError";
		error.code = behavior.error.code;
		error.status = behavior.error.status;
		error.type = behavior.error.type;
		throw error;
	}
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
	if (!signal) {
		throw new Error(
			"deterministic model waitForAbort fixture requires params.signal",
		);
	}
	if (signal.aborted)
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	return new Promise<never>((_resolve, reject) => {
		signal.addEventListener(
			"abort",
			() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
			{ once: true },
		);
	});
}

async function abortableDelay(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted)
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

async function streamResponse(
	params: GenerateTextParams,
	response: string,
	stream: DeterministicModelPluginOptions["stream"],
	modelType: ModelTypeName,
): Promise<void> {
	if (!stream || typeof params.onStreamChunk !== "function") return;
	if (stream.modelTypes && !stream.modelTypes.includes(modelType)) return;
	if (
		!Number.isSafeInteger(stream.chunkSize) ||
		stream.chunkSize <= 0 ||
		stream.intervalMs < 0
	) {
		throw new Error("deterministic model stream configuration is invalid");
	}
	for (let offset = 0; offset < response.length; offset += stream.chunkSize) {
		await params.onStreamChunk(
			response.slice(offset, offset + stream.chunkSize),
		);
		if (offset + stream.chunkSize < response.length && stream.intervalMs > 0) {
			await new Promise<void>((resolve) =>
				setTimeout(resolve, stream.intervalMs),
			);
		}
	}
}

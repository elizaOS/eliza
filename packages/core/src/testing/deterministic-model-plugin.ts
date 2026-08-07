/**
 * Fixture-driven model provider for real-runtime tests.
 *
 * The plugin participates in normal model dispatch alongside production providers,
 * but returns only caller-declared responses. Unmatched or ambiguous calls fail so
 * deterministic tests cannot pass by inventing a plausible model decision.
 */
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
}

export interface DeterministicModelCallDiagnostic {
	modelType: ModelTypeName;
	latestUserText: string;
	prompt: string;
	toolNames: string[];
	matchedFixtureName?: string;
	responseSchemaFingerprint?: string;
}

export interface DeterministicModelFixtureDiagnostic {
	name: string;
	consumed: number;
	min: number;
	max: number | "unbounded";
	required: boolean;
}

export interface DeterministicModelDiagnostics {
	calls: DeterministicModelCallDiagnostic[];
	fixtures: DeterministicModelFixtureDiagnostic[];
	unexpectedCalls: DeterministicModelCallDiagnostic[];
}

export interface DeterministicModelFixtureRegistry {
	register(...fixtures: DeterministicModelFixture[]): void;
	assertConsumed(): void;
	clear(): void;
	diagnostics(): DeterministicModelDiagnostics;
	resetConsumption(): void;
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
		readonly kind: "unmatched" | "ambiguous",
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

	const registry: DeterministicModelFixtureRegistry = {
		register(...next): void {
			for (const fixture of next) entries.push(registerFixture(fixture));
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
		},
		diagnostics: () => ({
			calls: [...calls],
			fixtures: entries.map(fixtureDiagnostic),
			unexpectedCalls: [...unexpectedCalls],
		}),
		resetConsumption(): void {
			calls.length = 0;
			unexpectedCalls.length = 0;
			for (const fixture of entries) fixture.consumed = 0;
		},
	};

	registry.register(...fixtures);
	registryResolvers.set(registry, (call) => {
		const diagnostic = callDiagnostic(call);
		calls.push(diagnostic);
		const matching = entries.filter(
			(fixture) =>
				matchesFixture(fixture, call) && fixture.consumed < fixture.max,
		);
		if (matching.length !== 1) {
			unexpectedCalls.push(diagnostic);
			const reason =
				matching.length === 0
					? "no fixture matched"
					: "multiple fixtures matched";
			throw new DeterministicModelMatchError(
				matching.length === 0 ? "unmatched" : "ambiguous",
				`deterministic model call failed: ${reason}: ${JSON.stringify({ call: diagnostic, fixtures: matching.map((fixture) => fixture.name) })}`,
			);
		}
		const fixture = matching[0];
		const response = resolveFixtureResponse(fixture, call);
		if (response === null || response === undefined) {
			unexpectedCalls.push(diagnostic);
			throw new Error(
				`deterministic model fixture "${fixture.name}" did not return a response`,
			);
		}
		fixture.consumed += 1;
		diagnostic.matchedFixtureName = fixture.name;
		return normalizeResponse(response);
	});
	registryUnmatchedRollbacks.set(registry, () => {
		unexpectedCalls.pop();
	});
	return registry;
}

const registryResolvers = new WeakMap<
	DeterministicModelFixtureRegistry,
	(call: DeterministicModelCall) => string
>();
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
			const resolveFixture = registryResolvers.get(fixtures);
			if (!resolveFixture) {
				throw new Error(
					"deterministic model fixture registry was not created by createDeterministicModelFixtureRegistry",
				);
			}
			let response: string;
			try {
				response = resolveFixture(call);
			} catch (error) {
				if (
					!(error instanceof DeterministicModelMatchError) ||
					error.kind !== "unmatched" ||
					!options.resolve
				)
					throw error;
				const resolved = options.resolve(call);
				if (resolved === null || resolved === undefined) throw error;
				registryUnmatchedRollbacks.get(fixtures)?.();
				response = normalizeResponse(resolved);
			}
			await streamResponse(params, response, options.stream, modelType);
			return response;
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

function registerFixture(
	fixture: DeterministicModelFixture,
): RegisteredFixture {
	if (!fixture.name.trim())
		throw new Error("deterministic model fixture name is required");
	if (fixture.response === undefined && fixture.resolve === undefined) {
		throw new Error(
			`deterministic model fixture "${fixture.name}" must define response or resolve`,
		);
	}
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
		!match.toolNames.every((name) => call.toolNames.includes(name))
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
	if (matcher instanceof RegExp) return matcher.test(value);
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
		: fixture.response;
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
		latestUserText: call.latestUserText,
		prompt: truncate(call.params.prompt ?? ""),
		toolNames: call.toolNames,
		responseSchemaFingerprint:
			call.params.responseSchema === undefined
				? undefined
				: stableStringify(call.params.responseSchema),
	};
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

function truncate(value: string): string {
	return value.length > 500 ? `${value.slice(0, 497)}...` : value;
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

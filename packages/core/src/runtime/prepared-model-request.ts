/**
 * Guards a provider-prepared model request at the final dispatch seam.
 * Providers supply the complete JSON-safe request projection they assembled;
 * the guard admits it once, freezes its plain request graph, and proves every
 * retry is byte-identical before the transport can run.
 */

import { ElizaError } from "../errors";
import {
	lookupModelContextWindow,
	lookupModelMaxOutputTokens,
} from "../features/trajectories/pricing";
import {
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	DEFAULT_INPUT_RESERVE_TOKENS,
} from "./model-input-budget";

export interface PreparedModelRequestBudget {
	provider: string;
	model: string;
	inputTokens: number;
	contextWindowTokens: number;
	outputReserveTokens: number;
	dispatchThresholdTokens: number;
	countSource: "provider-tokenizer" | "utf8-upper-bound";
	resolvedModelKey: string | null;
}

export interface PreparedModelRequestGuard {
	readonly budget: Readonly<PreparedModelRequestBudget>;
	readonly attempts: number;
	/** Revalidates the exact admitted body immediately before one transport try. */
	assertBeforeAttempt(): void;
}

export interface CreatePreparedModelRequestGuardArgs {
	provider: string;
	model: string;
	/**
	 * Rebuild the complete provider request projection from the actual dispatch
	 * object. The projection must contain every model-visible field, but omit
	 * transport-only collaborators such as fetch functions and AbortSignal.
	 */
	projectRequest?: () => unknown;
	/**
	 * Return the exact already-serialized transport body. Use this at fetch and
	 * SDK seams where re-projecting JSON would not prove wire-byte identity.
	 */
	serializeRequest?: () => string;
	/** Provider/model hard ceiling when it is known more precisely than lookup. */
	contextWindowTokens?: number;
	/** Actual requested output cap, or the model maximum when the field is omitted. */
	outputReserveTokens?: number;
	/** Provider tokenizer over the serialized prepared body, when available. */
	countInputTokens?: (serializedRequest: string) => number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertFinitePositiveInteger(
	value: number | undefined,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) {
		throw new ElizaError(`Prepared model request ${field} must be positive`, {
			code: "MODEL_PREPARED_REQUEST_INVALID_BUDGET",
			context: { field },
		});
	}
	return Math.floor(value);
}

/**
 * Reject graph shapes whose JSON encoding could silently omit model content.
 * Provider projections deliberately use only JSON body values; transport-only
 * objects must stay outside this graph.
 */
function validatePreparedJsonGraph(value: unknown): void {
	const active = new WeakSet<object>();
	const visit = (candidate: unknown, location: string): void => {
		if (
			candidate === null ||
			typeof candidate === "string" ||
			typeof candidate === "boolean"
		) {
			return;
		}
		if (typeof candidate === "number") {
			if (Number.isFinite(candidate)) return;
			throw new ElizaError(
				"Prepared model request contains a non-finite number",
				{
					code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
					context: { location },
				},
			);
		}
		if (candidate === undefined) return;
		if (typeof candidate !== "object") {
			throw new ElizaError("Prepared model request contains a non-JSON value", {
				code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
				context: { location, valueType: typeof candidate },
			});
		}
		if (active.has(candidate)) {
			throw new ElizaError("Prepared model request contains a cycle", {
				code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
				context: { location },
			});
		}
		if (!Array.isArray(candidate) && !isPlainRecord(candidate)) {
			throw new ElizaError("Prepared model request contains an opaque object", {
				code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
				context: {
					location,
					constructor: candidate.constructor?.name ?? "unknown",
				},
			});
		}
		active.add(candidate);
		if (Array.isArray(candidate)) {
			for (let index = 0; index < candidate.length; index += 1) {
				visit(candidate[index], `${location}[${index}]`);
			}
		} else {
			for (const key of Object.keys(candidate)) {
				const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
				if (!descriptor || descriptor.get || descriptor.set) {
					throw new ElizaError(
						"Prepared model request contains an accessor property",
						{
							code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
							context: { location: `${location}.${key}` },
						},
					);
				}
				visit(descriptor.value, `${location}.${key}`);
			}
		}
		active.delete(candidate);
	};
	visit(value, "$request");
}

function freezePreparedJsonGraph(value: unknown): void {
	const visited = new WeakSet<object>();
	const visit = (candidate: unknown): void => {
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			visited.has(candidate)
		) {
			return;
		}
		if (!Array.isArray(candidate) && !isPlainRecord(candidate)) return;
		visited.add(candidate);
		for (const nested of Object.values(candidate)) visit(nested);
		Object.freeze(candidate);
	};
	visit(value);
}

function serializePreparedRequest(value: unknown): string {
	validatePreparedJsonGraph(value);
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error("root value has no JSON representation");
		}
		return serialized;
	} catch (cause) {
		if (cause instanceof ElizaError) throw cause;
		throw new ElizaError("Prepared model request cannot be serialized", {
			code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
			cause,
		});
	}
}

function countPreparedInputTokens(
	serialized: string,
	counter: ((serializedRequest: string) => number) | undefined,
): { count: number; source: PreparedModelRequestBudget["countSource"] } {
	if (!counter) {
		return {
			count: new TextEncoder().encode(serialized).byteLength,
			source: "utf8-upper-bound",
		};
	}
	let count: number;
	try {
		count = counter(serialized);
	} catch (cause) {
		throw new ElizaError("Provider tokenizer failed before model dispatch", {
			code: "MODEL_PREPARED_REQUEST_TOKENIZATION_FAILED",
			cause,
		});
	}
	if (!Number.isFinite(count) || count < 0) {
		throw new ElizaError("Provider tokenizer returned an invalid token count", {
			code: "MODEL_PREPARED_REQUEST_TOKENIZATION_FAILED",
		});
	}
	return { count: Math.ceil(count), source: "provider-tokenizer" };
}

/**
 * Admit one complete provider-prepared request and return its retry guard.
 * Construction itself is the zero-dispatch rejection point; callers then must
 * invoke `assertBeforeAttempt` directly before every SDK/fetch attempt.
 */
export function createPreparedModelRequestGuard(
	args: CreatePreparedModelRequestGuardArgs,
): PreparedModelRequestGuard {
	const provider = args.provider.trim();
	const model = args.model.trim();
	if (!provider || !model) {
		throw new ElizaError(
			"Prepared model request needs provider and model ids",
			{
				code: "MODEL_PREPARED_REQUEST_INVALID_BUDGET",
			},
		);
	}
	if (Boolean(args.projectRequest) === Boolean(args.serializeRequest)) {
		throw new ElizaError(
			"Prepared model request needs exactly one request serializer",
			{ code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED" },
		);
	}

	const readSerializedRequest = (): string => {
		if (args.serializeRequest) {
			const body = args.serializeRequest();
			if (typeof body !== "string") {
				throw new ElizaError(
					"Prepared model request serializer did not return a string",
					{ code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED" },
				);
			}
			return body;
		}
		return serializePreparedRequest(args.projectRequest?.());
	};
	const initialRequest = args.projectRequest?.();
	const serialized = args.projectRequest
		? serializePreparedRequest(initialRequest)
		: readSerializedRequest();
	if (args.projectRequest) freezePreparedJsonGraph(initialRequest);
	const counted = countPreparedInputTokens(serialized, args.countInputTokens);
	const contextLookup = lookupModelContextWindow(model);
	const outputLookup = lookupModelMaxOutputTokens(model);
	const contextWindowTokens =
		assertFinitePositiveInteger(
			args.contextWindowTokens,
			"contextWindowTokens",
		) ??
		contextLookup?.contextWindowTokens ??
		DEFAULT_CONTEXT_WINDOW_TOKENS;
	const outputReserveTokens = Math.max(
		DEFAULT_INPUT_RESERVE_TOKENS,
		assertFinitePositiveInteger(
			args.outputReserveTokens,
			"outputReserveTokens",
		) ??
			outputLookup?.maxOutputTokens ??
			0,
	);
	const dispatchThresholdTokens = Math.max(
		1,
		contextWindowTokens - outputReserveTokens,
	);
	const budget = Object.freeze({
		provider,
		model,
		inputTokens: counted.count,
		contextWindowTokens,
		outputReserveTokens,
		dispatchThresholdTokens,
		countSource: counted.source,
		resolvedModelKey: contextLookup?.matchedKey ?? null,
	}) satisfies Readonly<PreparedModelRequestBudget>;

	if (counted.count >= dispatchThresholdTokens) {
		throw new ElizaError(
			"Complete provider-prepared model request exceeds its context budget",
			{
				code: "MODEL_INPUT_OVER_BUDGET",
				context: { ...budget },
			},
		);
	}

	let attempts = 0;
	return {
		budget,
		get attempts() {
			return attempts;
		},
		assertBeforeAttempt(): void {
			const attemptSerialized = readSerializedRequest();
			if (attemptSerialized !== serialized) {
				throw new ElizaError(
					"Provider-prepared model request changed after admission",
					{
						code: "MODEL_PREPARED_REQUEST_MUTATED",
						context: { provider, model, attempt: attempts + 1 },
					},
				);
			}
			const attemptCount = countPreparedInputTokens(
				attemptSerialized,
				args.countInputTokens,
			);
			if (
				attemptCount.count !== counted.count ||
				attemptCount.source !== counted.source
			) {
				throw new ElizaError(
					"Provider token count changed for an identical admitted request",
					{
						code: "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT",
						context: { provider, model, attempt: attempts + 1 },
					},
				);
			}
			attempts += 1;
		},
	};
}

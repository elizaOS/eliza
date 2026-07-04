/**
 * `EvaluatorService`: the runtime singleton that runs every registered post-turn
 * evaluator in a single merged, schema-constrained SMALL-model call, then routes
 * each evaluator's slice of the output through its processors. Exposes the
 * `runPostTurnEvaluators` helper the message loop invokes after a turn (skipped on
 * mobile, where reflection would serialize on the on-device engine). Remembers,
 * per runtime, when a provider rejects schema-constrained output and falls back to
 * a json_object request so a doomed schema round-trip is not repaid every turn.
 */
import { v4 as uuidv4 } from "uuid";
import { logger } from "../logger.ts";
import { isMobilePlatform } from "../runtime-env.ts";
import { setTrajectoryPurpose } from "../trajectory-context.ts";
import type {
	ActionResult,
	EvaluatorRunContext,
	EvaluatorRunOptions,
	EvaluatorRunResult,
	IAgentRuntime,
	JSONSchema,
	JsonValue,
	Memory,
	RegisteredEvaluator,
	Service,
	State,
} from "../types/index.ts";
import { EventType, ModelType } from "../types/index.ts";
import { Service as BaseService } from "../types/service.ts";
import { isObjectRecord as isRecord } from "../utils/type-guards.ts";

type PreparedEntry = {
	evaluator: RegisteredEvaluator;
	prepared: unknown;
};

const EMPTY_STATE: State = {
	values: {},
	data: {},
	text: "",
};

function stringifyForPrompt(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function coerceObjectOutput(raw: unknown): Record<string, unknown> | null {
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function mergeStates(base: State | undefined, providerState: State): State {
	if (!base) return providerState;
	const providerData = providerState.data.providers;
	const baseProviderData = base.data.providers;
	const mergedProviders =
		isRecord(baseProviderData) || isRecord(providerData)
			? {
					...(isRecord(baseProviderData) ? baseProviderData : {}),
					...(isRecord(providerData) ? providerData : {}),
				}
			: undefined;

	return {
		values: {
			...base.values,
			...providerState.values,
		},
		data: {
			...base.data,
			...providerState.data,
			...(mergedProviders ? { providers: mergedProviders } : {}),
		},
		text: [base.text, providerState.text].filter(Boolean).join("\n"),
	};
}

function buildMergedSchema(active: PreparedEntry[]): JSONSchema {
	return {
		type: "object",
		properties: Object.fromEntries(
			active.map(({ evaluator }) => [evaluator.name, evaluator.schema]),
		),
		required: active.map(({ evaluator }) => evaluator.name),
		additionalProperties: false,
	};
}

function buildPrompt(params: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	active: PreparedEntry[];
	options: EvaluatorRunOptions;
}): string {
	const { runtime, message, state, active, options } = params;
	const agentName = runtime.character.name ?? "Agent";
	const latestMessage = message.content.text ?? "";
	const responseTexts = (options.responses ?? [])
		.map((response) => response.content.text)
		.filter(
			(text): text is string => typeof text === "string" && text.length > 0,
		)
		.join("\n");
	const actionResults = isRecord(state.data)
		? state.data.actionResults
		: undefined;
	const providerContext = state.text.trim() || "(none)";

	const evaluatorSections = active
		.map(({ evaluator, prepared }) => {
			const section = evaluator.prompt({
				runtime,
				message,
				state,
				options,
				prepared,
			});
			return [
				`### ${evaluator.name}`,
				evaluator.description,
				"",
				section,
				"",
				`Put result under "${evaluator.name}".`,
			].join("\n");
		})
		.join("\n\n");

	return `# Task: Post-turn evaluation

Evaluate just-finished turn for ${agentName}.

Return exactly one JSON object. No prose, markdown fences, XML, hidden reasoning.
One top-level property per active evaluator. Use only provided context. Nothing to record => empty shape.

## Shared Turn Context

Agent ID: ${runtime.agentId}
Agent name: ${agentName}
Message ID: ${message.id ?? "(none)"}
Room ID: ${message.roomId}
Sender entity ID: ${message.entityId}
Did respond: ${options.didRespond === true ? "true" : "false"}

Latest message:
${latestMessage || "(none)"}

Agent response messages:
${responseTexts || "(none)"}

Action results:
${stringifyForPrompt(actionResults ?? [])}

Provider context:
${providerContext}

## Active Evaluators

${evaluatorSections}
`;
}

// Schema-SPECIFIC rejection tokens: a HIGH-CONFIDENCE signal that the provider
// STRUCTURALLY rejects schema-constrained output (vs a generic/transient HTTP
// 400 that merely says "bad request" — rate-limit, malformed prompt, context
// length, gateway blip). Single source of truth so the immediate-arm set can
// never silently drift from the broader fallback set below.
const SCHEMA_SPECIFIC_REJECTION_TOKENS = [
	"response schema",
	"responseschema",
	"json_schema",
	"structured output",
] as const;

function errorMessageText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error ?? ""))
		.toLowerCase()
		.trim();
}

// Only a schema-specific rejection should arm the lifetime memo on its own; a
// bare "bad request" still falls back for the turn but is re-attempted next turn
// (gated by a streak below) so a one-off blip cannot permanently downgrade a
// schema-capable provider.
function schemaRejectionLooksPersistent(error: unknown): boolean {
	const message = errorMessageText(error);
	return SCHEMA_SPECIFIC_REJECTION_TOKENS.some((token) =>
		message.includes(token),
	);
}

// Generic "bad request" is intentionally broad here (it drives the per-turn
// json_object fallback). Deriving this from schemaRejectionLooksPersistent
// guarantees the immediate-arm token set stays a strict subset of the fallback
// set — add a schema token in one place and both predicates pick it up.
function schemaRequestLooksUnsupported(error: unknown): boolean {
	const message = errorMessageText(error);
	if (!message) return false;
	return (
		message.includes("bad request") || schemaRejectionLooksPersistent(error)
	);
}

// Once a runtime's SMALL model rejects a structured `responseSchema` request,
// every subsequent request will be rejected the same way — the provider simply
// does not support schema-constrained output (e.g. the cerebras gpt-oss path on
// Eliza Cloud). Re-sending the schema each turn burns a full, DOOMED model
// round-trip before the json_object retry succeeds — measured at ~4.5s of pure
// waste on every turn. Remember the rejection per runtime and, from then on,
// skip straight to the json_object request. Keyed by the live runtime instance
// (a WeakSet, so it never leaks across agents).
//
// The memo is armed conservatively (see below): a schema-specific rejection
// arms it immediately, but a bare/generic "bad request" must recur
// `SCHEMA_UNSUPPORTED_STREAK_THRESHOLD` times in a row — any schema SUCCESS in
// between resets the streak — so a transient 400 self-heals instead of
// permanently downgrading a genuinely schema-capable provider.
const schemaUnsupportedRuntimes = new WeakSet<object>();
const schemaRejectionStreak = new WeakMap<object, number>();
const SCHEMA_UNSUPPORTED_STREAK_THRESHOLD = 2;

async function generateEvaluationOutput(params: {
	runtime: IAgentRuntime;
	prompt: string;
	schema: JSONSchema;
}): Promise<unknown> {
	const { runtime, prompt, schema } = params;
	const messages = [{ role: "user" as const, content: prompt }];
	// Post-turn evaluation runs on the SMALL model: it is a cheap, frequent,
	// structured extraction/classification pass (all active evaluators share one
	// merged call), not generation — the large model is wasted cost here,
	// especially for local-first tiers.
	const requestJsonObject = (): Promise<unknown> =>
		runtime.useModel(ModelType.TEXT_SMALL, {
			messages,
			responseFormat: { type: "json_object" },
			temperature: 0,
		});
	const requestPlain = (): Promise<unknown> =>
		runtime.useModel(ModelType.TEXT_SMALL, {
			messages,
			temperature: 0,
		});
	const afterJsonObjectRejected = async (
		fallbackError: unknown,
	): Promise<unknown> => {
		if (!schemaRequestLooksUnsupported(fallbackError)) throw fallbackError;
		runtime.logger.debug(
			{ src: "service:evaluator" },
			"Post-turn evaluator JSON-object fallback rejected; retrying plain JSON prompt",
		);
		return requestPlain();
	};

	// This runtime already proved its SMALL model rejects schema-constrained
	// output — don't pay for the doomed schema round-trip again.
	if (schemaUnsupportedRuntimes.has(runtime)) {
		try {
			return await requestJsonObject();
		} catch (fallbackError) {
			return afterJsonObjectRejected(fallbackError);
		}
	}

	try {
		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			messages,
			responseSchema: schema,
			responseFormat: { type: "json_object" },
			temperature: 0,
		});
		// Schema worked this turn — clear any prior rejection streak so a stray
		// earlier 400 never accumulates toward a permanent downgrade.
		schemaRejectionStreak.delete(runtime);
		return result;
	} catch (error) {
		if (!schemaRequestLooksUnsupported(error)) throw error;
		// Decide whether this rejection is structural enough to PERMANENTLY skip
		// the schema attempt from now on. A schema-specific message arms the memo
		// immediately; a generic "bad request" must recur THRESHOLD times in a row
		// (a single transient blip self-heals on the next schema success).
		const streak = (schemaRejectionStreak.get(runtime) ?? 0) + 1;
		schemaRejectionStreak.set(runtime, streak);
		if (
			!schemaUnsupportedRuntimes.has(runtime) &&
			(schemaRejectionLooksPersistent(error) ||
				streak >= SCHEMA_UNSUPPORTED_STREAK_THRESHOLD)
		) {
			schemaUnsupportedRuntimes.add(runtime);
			// WARN (not debug) so an erroneous permanent downgrade is observable.
			runtime.logger.warn(
				{ src: "service:evaluator", streak },
				"Post-turn evaluator: provider rejected schema-constrained output; disabling schema requests for this runtime (json_object fallback)",
			);
		}
		runtime.logger.debug(
			{ src: "service:evaluator" },
			"Post-turn evaluator schema request rejected; retrying JSON-object fallback",
		);
		try {
			return await requestJsonObject();
		} catch (fallbackError) {
			return afterJsonObjectRejected(fallbackError);
		}
	}
}

export class EvaluatorService extends BaseService {
	static serviceType = "evaluator" as const;
	capabilityDescription =
		"Runs registered post-turn evaluators in one structured model call";

	static async start(runtime: IAgentRuntime): Promise<Service> {
		return new EvaluatorService(runtime);
	}

	async stop(): Promise<void> {
		// Stateless service.
	}

	list(): RegisteredEvaluator[] {
		return [...this.runtime.evaluators];
	}

	register(evaluator: RegisteredEvaluator): void {
		this.runtime.registerEvaluator(evaluator);
	}

	unregister(name: string): boolean {
		return this.runtime.unregisterEvaluator(name);
	}

	private sortEvaluators(
		evaluators: RegisteredEvaluator[],
	): RegisteredEvaluator[] {
		return evaluators.sort(
			(a, b) =>
				(a.priority ?? 100) - (b.priority ?? 100) ||
				a.name.localeCompare(b.name),
		);
	}

	private async collectActiveEvaluators(
		candidates: RegisteredEvaluator[],
		context: EvaluatorRunContext,
		errors: EvaluatorRunResult["errors"],
	): Promise<RegisteredEvaluator[]> {
		const active: RegisteredEvaluator[] = [];
		await Promise.all(
			candidates.map(async (evaluator) => {
				try {
					if (await evaluator.shouldRun(context)) active.push(evaluator);
				} catch (error) {
					const messageText =
						error instanceof Error ? error.message : String(error);
					errors.push({ evaluatorName: evaluator.name, error: messageText });
					this.runtime.logger.warn(
						{
							src: "service:evaluator",
							agentId: this.runtime.agentId,
							evaluator: evaluator.name,
							err: messageText,
						},
						"Evaluator shouldRun failed",
					);
				}
			}),
		);
		return this.sortEvaluators(active);
	}

	private async composeEvaluatorState(
		message: Memory,
		state: State | undefined,
		active: RegisteredEvaluator[],
	): Promise<State> {
		const providerNames = Array.from(
			new Set(active.flatMap((evaluator) => evaluator.providers ?? [])),
		);
		const providerState =
			providerNames.length > 0
				? await this.runtime.composeState(message, providerNames, true, true)
				: EMPTY_STATE;
		return mergeStates(state, providerState);
	}

	private async collectPreparedEntries(
		active: RegisteredEvaluator[],
		message: Memory,
		state: State,
		options: EvaluatorRunOptions,
		errors: EvaluatorRunResult["errors"],
	): Promise<PreparedEntry[]> {
		const preparedEntries: PreparedEntry[] = [];
		await Promise.all(
			active.map(async (evaluator) => {
				try {
					const prepared = evaluator.prepare
						? await evaluator.prepare({
								runtime: this.runtime,
								message,
								state,
								options,
							})
						: undefined;
					preparedEntries.push({ evaluator, prepared });
				} catch (error) {
					const messageText =
						error instanceof Error ? error.message : String(error);
					errors.push({ evaluatorName: evaluator.name, error: messageText });
					this.runtime.logger.warn(
						{
							src: "service:evaluator",
							agentId: this.runtime.agentId,
							evaluator: evaluator.name,
							err: messageText,
						},
						"Evaluator prepare failed",
					);
				}
			}),
		);
		return preparedEntries.sort(
			(a, b) =>
				(a.evaluator.priority ?? 100) - (b.evaluator.priority ?? 100) ||
				a.evaluator.name.localeCompare(b.evaluator.name),
		);
	}

	private async emitEvaluatorCompleted(
		evaluatorId: string,
		completed: boolean,
		error?: Error,
	): Promise<void> {
		await this.runtime
			.emitEvent(EventType.EVALUATOR_COMPLETED, {
				runtime: this.runtime,
				evaluatorId,
				evaluatorName: "post_turn",
				completed,
				...(error ? { error } : {}),
			})
			.catch(() => {});
	}

	private async readEvaluatorOutput(params: {
		evaluatorId: string;
		prompt: string;
		schema: JSONSchema;
	}): Promise<{ output: Record<string, unknown> | null; error?: string }> {
		const { evaluatorId, prompt, schema } = params;
		let raw: unknown;
		try {
			raw = await generateEvaluationOutput({
				runtime: this.runtime,
				prompt,
				schema,
			});
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			await this.emitEvaluatorCompleted(
				evaluatorId,
				false,
				error instanceof Error ? error : new Error(messageText),
			);
			return { output: null, error: messageText };
		}

		const output = coerceObjectOutput(raw);
		if (!output) {
			const messageText = "Evaluator model returned non-object output";
			await this.emitEvaluatorCompleted(
				evaluatorId,
				false,
				new Error(messageText),
			);
			return { output: null, error: messageText };
		}
		return { output };
	}

	private async processPreparedEntries(params: {
		preparedEntries: PreparedEntry[];
		output: Record<string, unknown>;
		message: Memory;
		state: State;
		options: EvaluatorRunOptions;
		errors: EvaluatorRunResult["errors"];
	}): Promise<{
		processedEvaluators: string[];
		results: ActionResult[];
	}> {
		const { preparedEntries, output, message, state, options, errors } = params;
		const results: ActionResult[] = [];
		const processedEvaluators: string[] = [];
		for (const entry of preparedEntries) {
			const { evaluator, prepared } = entry;
			const rawSection = output[evaluator.name];
			if (rawSection === undefined) continue;
			const parsed = evaluator.parse
				? evaluator.parse(rawSection)
				: (rawSection as JsonValue);
			if (parsed === null || parsed === undefined) {
				// The returned `errors` array is not read by every caller, so this
				// structured warn is the field-visible trace of a parse failure
				// (#11239/#11253). stringifyForPrompt (safe try/catch) — a raw
				// JSON.stringify throws on a circular/bigint section and would turn
				// one evaluator's parse failure into an abort of the whole run.
				this.runtime.logger.warn(
					{
						src: "service:evaluator",
						agentId: this.runtime.agentId,
						evaluator: evaluator.name,
						rawSection: stringifyForPrompt(rawSection).slice(0, 500),
					},
					"Evaluator output section did not validate",
				);
				errors.push({
					evaluatorName: evaluator.name,
					error: "Evaluator output section did not validate",
				});
				continue;
			}
			await this.runEntryProcessors({
				evaluator,
				prepared,
				parsed: parsed as JsonValue,
				message,
				state,
				options,
				results,
				errors,
			});
			processedEvaluators.push(evaluator.name);
		}
		return { processedEvaluators, results };
	}

	private async runEntryProcessors(params: {
		evaluator: RegisteredEvaluator;
		prepared: unknown;
		parsed: JsonValue;
		message: Memory;
		state: State;
		options: EvaluatorRunOptions;
		results: ActionResult[];
		errors: EvaluatorRunResult["errors"];
	}): Promise<void> {
		const {
			evaluator,
			prepared,
			parsed,
			message,
			state,
			options,
			results,
			errors,
		} = params;
		const processors = (evaluator.processors ?? [])
			.slice()
			.sort(
				(a, b) =>
					(a.priority ?? 100) - (b.priority ?? 100) ||
					(a.name ?? "").localeCompare(b.name ?? ""),
			);
		for (const processor of processors) {
			try {
				const result = await processor.process({
					runtime: this.runtime,
					message,
					state,
					options,
					prepared,
					output: parsed,
					evaluatorName: evaluator.name,
				});
				if (result) results.push(result);
			} catch (error) {
				const messageText =
					error instanceof Error ? error.message : String(error);
				errors.push({
					evaluatorName: evaluator.name,
					processorName: processor.name,
					error: messageText,
				});
				this.runtime.logger.warn(
					{
						src: "service:evaluator",
						agentId: this.runtime.agentId,
						evaluator: evaluator.name,
						processor: processor.name,
						err: messageText,
					},
					"Evaluator processor failed",
				);
			}
		}
	}

	private skippedResult(params?: {
		activeEvaluators?: string[];
		processedEvaluators?: string[];
		errors?: EvaluatorRunResult["errors"];
	}): EvaluatorRunResult {
		return {
			skipped: true,
			activeEvaluators: params?.activeEvaluators ?? [],
			processedEvaluators: params?.processedEvaluators ?? [],
			results: [],
			errors: params?.errors ?? [],
		};
	}

	private failedResult(params: {
		preparedEntries: PreparedEntry[];
		errors: EvaluatorRunResult["errors"];
		error: string;
	}): EvaluatorRunResult {
		return {
			skipped: false,
			activeEvaluators: params.preparedEntries.map(
				({ evaluator }) => evaluator.name,
			),
			processedEvaluators: [],
			results: [],
			errors: [
				...params.errors,
				{
					evaluatorName: "post_turn",
					error: params.error,
				},
			],
		};
	}

	async run(
		message: Memory,
		state?: State,
		options: EvaluatorRunOptions = {},
	): Promise<EvaluatorRunResult> {
		setTrajectoryPurpose("evaluation");

		const context: EvaluatorRunContext = {
			runtime: this.runtime,
			message,
			state,
			options,
		};

		const candidates = this.sortEvaluators(this.runtime.evaluators.slice());
		if (candidates.length === 0) {
			return this.skippedResult();
		}

		const errors: EvaluatorRunResult["errors"] = [];
		const active = await this.collectActiveEvaluators(
			candidates,
			context,
			errors,
		);
		if (active.length === 0) {
			return this.skippedResult({ errors });
		}

		const composedState = await this.composeEvaluatorState(
			message,
			state,
			active,
		);
		const preparedEntries = await this.collectPreparedEntries(
			active,
			message,
			composedState,
			options,
			errors,
		);
		if (preparedEntries.length === 0) {
			return this.skippedResult({
				activeEvaluators: active.map((evaluator) => evaluator.name),
				errors,
			});
		}

		const evaluatorId =
			uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
		await this.runtime
			.emitEvent(EventType.EVALUATOR_STARTED, {
				runtime: this.runtime,
				evaluatorId,
				evaluatorName: "post_turn",
				startTime: Date.now(),
			})
			.catch(() => {});

		const prompt = buildPrompt({
			runtime: this.runtime,
			message,
			state: composedState,
			active: preparedEntries,
			options,
		});
		const schema = buildMergedSchema(preparedEntries);
		const { output, error } = await this.readEvaluatorOutput({
			evaluatorId,
			prompt,
			schema,
		});
		if (!output) {
			return this.failedResult({
				preparedEntries,
				errors,
				error: error ?? "Evaluator model returned no output",
			});
		}

		const { processedEvaluators, results } = await this.processPreparedEntries({
			preparedEntries,
			output,
			message,
			state: composedState,
			options,
			errors,
		});

		await this.emitEvaluatorCompleted(evaluatorId, true);

		return {
			skipped: false,
			activeEvaluators: preparedEntries.map(({ evaluator }) => evaluator.name),
			processedEvaluators,
			results,
			errors,
		};
	}
}

export async function runPostTurnEvaluators(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options: EvaluatorRunOptions = {},
): Promise<EvaluatorRunResult | null> {
	// On mobile (single on-device GPU context, single-threaded agent) the
	// post-turn reflection pass is a 256-512 token generation that serializes on
	// the SAME engine as the user reply and blocks the next inbound turn for
	// ~30-64s. Skip it on android/ios — reflection's value at the 2B local tier
	// is marginal and not worth the per-turn latency. Desktop/server keep it.
	if (isMobilePlatform()) {
		return null;
	}
	try {
		const service = (await runtime.getServiceLoadPromise(
			EvaluatorService.serviceType,
		)) as EvaluatorService;
		return await service.run(message, state, {
			...options,
			phase: options.phase ?? "post_turn",
		});
	} catch (error) {
		logger.debug(
			{
				src: "service:evaluator",
				agentId: runtime.agentId,
				err: error instanceof Error ? error.message : String(error),
			},
			"Post-turn evaluator service unavailable",
		);
		return null;
	}
}

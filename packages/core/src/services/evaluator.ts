import { v4 as uuidv4 } from "uuid";
import { logger } from "../logger.ts";
import { setTrajectoryPurpose } from "../trajectory-context.ts";
import type {
	ActionResult,
	Evaluator,
	EvaluatorRunContext,
	EvaluatorRunOptions,
	EvaluatorRunResult,
	IAgentRuntime,
	JSONSchema,
	JsonValue,
	Memory,
	Service,
	State,
} from "../types/index.ts";
import { EventType, ModelType } from "../types/index.ts";
import { Service as BaseService } from "../types/service.ts";

type PreparedEntry = {
	evaluator: Evaluator;
	prepared: unknown;
};

const EMPTY_STATE: State = {
	values: {},
	data: {},
	text: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	const providerData = providerState.data?.providers;
	const baseProviderData = base.data?.providers;
	const mergedProviders =
		isRecord(baseProviderData) || isRecord(providerData)
			? {
					...(isRecord(baseProviderData) ? baseProviderData : {}),
					...(isRecord(providerData) ? providerData : {}),
				}
			: undefined;

	return {
		values: {
			...(base.values ?? {}),
			...(providerState.values ?? {}),
		},
		data: {
			...(base.data ?? {}),
			...(providerState.data ?? {}),
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
	const latestMessage = message.content?.text ?? "";
	const responseTexts = (options.responses ?? [])
		.map((response) => response.content?.text)
		.filter(
			(text): text is string => typeof text === "string" && text.length > 0,
		)
		.join("\n");
	const actionResults = isRecord(state.data)
		? state.data.actionResults
		: undefined;
	const providerContext = state.text?.trim() || "(none)";

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
				`Output this evaluator's result under property "${evaluator.name}".`,
			].join("\n");
		})
		.join("\n\n");

	return `# Task: Post-turn evaluation

You are evaluating the just-finished message turn for ${agentName}.

Return exactly one JSON object. Do not include prose, markdown fences, XML, or hidden reasoning.
Populate one top-level property for each active evaluator listed below. Use only the provided context. If an evaluator has nothing to record, return its empty shape.

## Shared Turn Context

Agent ID: ${runtime.agentId}
Agent name: ${agentName}
Message ID: ${message.id ?? "(none)"}
Room ID: ${message.roomId ?? "(none)"}
Sender entity ID: ${message.entityId ?? "(none)"}
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

	list(): Evaluator[] {
		return [...this.runtime.evaluators];
	}

	register(evaluator: Evaluator): void {
		this.runtime.registerEvaluator(evaluator);
	}

	unregister(name: string): boolean {
		return this.runtime.unregisterEvaluator(name);
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

		const candidates = this.runtime.evaluators
			.slice()
			.sort(
				(a, b) =>
					(a.priority ?? 100) - (b.priority ?? 100) ||
					a.name.localeCompare(b.name),
			);
		if (candidates.length === 0) {
			return {
				skipped: true,
				activeEvaluators: [],
				processedEvaluators: [],
				results: [],
				errors: [],
			};
		}

		const active: Evaluator[] = [];
		const errors: EvaluatorRunResult["errors"] = [];
		await Promise.all(
			candidates.map(async (evaluator) => {
				try {
					if (await evaluator.shouldRun(context)) active.push(evaluator);
				} catch (error) {
					errors.push({
						evaluatorName: evaluator.name,
						error: error instanceof Error ? error.message : String(error),
					});
					this.runtime.logger.warn(
						{
							src: "service:evaluator",
							agentId: this.runtime.agentId,
							evaluator: evaluator.name,
							err: error instanceof Error ? error.message : String(error),
						},
						"Evaluator shouldRun failed",
					);
				}
			}),
		);

		active.sort(
			(a, b) =>
				(a.priority ?? 100) - (b.priority ?? 100) ||
				a.name.localeCompare(b.name),
		);
		if (active.length === 0) {
			return {
				skipped: true,
				activeEvaluators: [],
				processedEvaluators: [],
				results: [],
				errors,
			};
		}

		const providerNames = Array.from(
			new Set(active.flatMap((evaluator) => evaluator.providers ?? [])),
		);
		const providerState =
			providerNames.length > 0
				? await this.runtime.composeState(message, providerNames, true, true)
				: EMPTY_STATE;
		const composedState = mergeStates(state, providerState);

		const preparedEntries: PreparedEntry[] = [];
		await Promise.all(
			active.map(async (evaluator) => {
				try {
					const prepared = evaluator.prepare
						? await evaluator.prepare({
								runtime: this.runtime,
								message,
								state: composedState,
								options,
							})
						: undefined;
					preparedEntries.push({ evaluator, prepared });
				} catch (error) {
					errors.push({
						evaluatorName: evaluator.name,
						error: error instanceof Error ? error.message : String(error),
					});
					this.runtime.logger.warn(
						{
							src: "service:evaluator",
							agentId: this.runtime.agentId,
							evaluator: evaluator.name,
							err: error instanceof Error ? error.message : String(error),
						},
						"Evaluator prepare failed",
					);
				}
			}),
		);
		preparedEntries.sort(
			(a, b) =>
				(a.evaluator.priority ?? 100) - (b.evaluator.priority ?? 100) ||
				a.evaluator.name.localeCompare(b.evaluator.name),
		);
		if (preparedEntries.length === 0) {
			return {
				skipped: true,
				activeEvaluators: active.map((evaluator) => evaluator.name),
				processedEvaluators: [],
				results: [],
				errors,
			};
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
		const raw = await this.runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
			responseSchema: schema,
			responseFormat: { type: "json_object" },
			temperature: 0,
		});
		const output = coerceObjectOutput(raw);
		if (!output) {
			await this.runtime
				.emitEvent(EventType.EVALUATOR_COMPLETED, {
					runtime: this.runtime,
					evaluatorId,
					evaluatorName: "post_turn",
					completed: false,
					error: new Error("Evaluator model returned non-object output"),
				})
				.catch(() => {});
			return {
				skipped: false,
				activeEvaluators: preparedEntries.map(
					({ evaluator }) => evaluator.name,
				),
				processedEvaluators: [],
				results: [],
				errors: [
					...errors,
					{
						evaluatorName: "post_turn",
						error: "Evaluator model returned non-object output",
					},
				],
			};
		}

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
				errors.push({
					evaluatorName: evaluator.name,
					error: "Evaluator output section did not validate",
				});
				continue;
			}
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
						state: composedState,
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
			processedEvaluators.push(evaluator.name);
		}

		await this.runtime
			.emitEvent(EventType.EVALUATOR_COMPLETED, {
				runtime: this.runtime,
				evaluatorId,
				evaluatorName: "post_turn",
				completed: true,
			})
			.catch(() => {});

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

import type { ActionResult, HandlerCallback } from "./components";
import type { Memory } from "./memory";
import type { JSONSchema, ModelTypeName } from "./model";
import type { JsonValue } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";

export interface EvaluatorRunOptions {
	didRespond?: boolean;
	responses?: Memory[];
	callback?: HandlerCallback;
	phase?: string;
}

export interface EvaluatorRunContext {
	runtime: IAgentRuntime;
	message: Memory;
	state?: State;
	options: EvaluatorRunOptions;
}

export interface EvaluatorPromptContext<TPrepared = unknown>
	extends EvaluatorRunContext {
	state: State;
	prepared: TPrepared;
}

export interface EvaluatorProcessorContext<
	TOutput = JsonValue,
	TPrepared = unknown,
> extends EvaluatorPromptContext<TPrepared> {
	output: TOutput;
	evaluatorName: string;
}

export interface EvaluatorProcessor<TOutput = JsonValue, TPrepared = unknown> {
	name?: string;
	priority?: number;
	process(
		context: EvaluatorProcessorContext<TOutput, TPrepared>,
	): Promise<ActionResult | undefined>;
}

export interface Evaluator<TOutput = JsonValue, TPrepared = unknown> {
	name: string;
	description: string;
	similes?: string[];
	priority?: number;
	providers?: string[];
	schema: JSONSchema;
	modelType?: ModelTypeName;

	shouldRun(context: EvaluatorRunContext): Promise<boolean>;
	prepare?(context: EvaluatorRunContext & { state: State }): Promise<TPrepared>;
	prompt(context: EvaluatorPromptContext<TPrepared>): string;
	parse?(output: unknown): TOutput | null;
	processors?: Array<EvaluatorProcessor<TOutput, TPrepared>>;
}

/**
 * Heterogeneous evaluators on the runtime or from plugins. Output/prepared
 * generics are erased to `unknown` so concrete `Evaluator<YourOutput, ...>`
 * instances are assignable without `any`.
 */
export type RegisteredEvaluator = Evaluator<unknown, unknown>;

export interface EvaluatorRunResult {
	skipped: boolean;
	activeEvaluators: string[];
	processedEvaluators: string[];
	results: ActionResult[];
	errors: Array<{
		evaluatorName: string;
		processorName?: string;
		error: string;
	}>;
}

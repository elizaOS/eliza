import type { ResponseSkeleton, SpanSamplerPlan } from "../types/model";
import {
  buildSpanSamplerPlan,
  withGuidedDecodeProviderOptions,
} from "./response-grammar";

export interface EvaluatorGuidance {
	responseSkeleton: ResponseSkeleton;
	grammar: string;
	spanSamplerPlan: SpanSamplerPlan;
}

const EVALUATOR_RESPONSE_SKELETON: ResponseSkeleton = {
	id: "evaluator#v1#success-decision-thought",
	spans: [
		{ kind: "literal", value: '{"success":' },
		{ kind: "boolean", key: "success" },
		{ kind: "literal", value: ',"decision":' },
		{
			kind: "enum",
			key: "decision",
			enumValues: ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"],
		},
		{ kind: "literal", value: ',"thought":' },
		{ kind: "free-string", key: "thought" },
		{ kind: "literal", value: "}" },
	],
};

const JSON_STRING_RULE =
	'jsonstring ::= "\\"" ( [^"\\\\\\x00-\\x1F] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] ) )* "\\""';

const EVALUATOR_GRAMMAR = [
	'root ::= "{" "\\"success\\":" jsonbool ",\\"decision\\":" decision ",\\"thought\\":" jsonstring ( ",\\"messageToUser\\":" jsonstring )? ( ",\\"copyToClipboard\\":" clipboard )? ( ",\\"recommendedToolCallId\\":" jsonstring )? "}"',
	'decision ::= "\\"FINISH\\"" | "\\"NEXT_RECOMMENDED\\"" | "\\"CONTINUE\\""',
	'clipboard ::= "{" "\\"title\\":" jsonstring ",\\"content\\":" jsonstring ( ",\\"tags\\":" jsonstringarray )? "}"',
	'jsonstringarray ::= "[" ws ( jsonstring ( ws "," ws jsonstring )* )? ws "]"',
	'jsonbool ::= "true" | "false"',
	JSON_STRING_RULE,
	'ws ::= "[ \\t\\n\\r]*"',
].join("\n");

let cachedGuidance: EvaluatorGuidance | null = null;

export function buildEvaluatorGuidance(): EvaluatorGuidance {
	if (cachedGuidance) return cachedGuidance;
	cachedGuidance = {
		responseSkeleton: EVALUATOR_RESPONSE_SKELETON,
		grammar: EVALUATOR_GRAMMAR,
		spanSamplerPlan: buildSpanSamplerPlan(EVALUATOR_RESPONSE_SKELETON),
	};
	return cachedGuidance;
}

export function withEvaluatorGuidedDecodeProviderOptions<
	T extends Record<string, unknown>,
>(providerOptions: T): T {
	return withGuidedDecodeProviderOptions(providerOptions);
}

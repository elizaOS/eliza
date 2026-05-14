import type {
	ResponseSkeleton,
	ResponseSkeletonSpan,
	SpanSamplerOverride,
	SpanSamplerPlan,
} from "../types/model";

const DECISIONS = ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"] as const;

export interface EvaluatorGuidance {
	responseSkeleton: ResponseSkeleton;
	grammar: string;
	spanSamplerPlan: SpanSamplerPlan;
}

function gbnfEscapeLiteral(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
		else out += ch;
	}
	return out;
}

function gbnfLiteral(text: string): string {
	return `"${gbnfEscapeLiteral(text)}"`;
}

function gbnfJsonStringLiteral(value: string): string {
	return gbnfLiteral(JSON.stringify(value));
}

function buildEvaluatorGrammar(): string {
	const decision = DECISIONS.map((value) => gbnfJsonStringLiteral(value)).join(
		" | ",
	);
	return [
		'root ::= "{" ws "\\"success\\"" ws ":" ws jsonbool ws "," ws "\\"decision\\"" ws ":" ws decision ws "," ws "\\"thought\\"" ws ":" ws jsonstring optional-message optional-clipboard optional-recommendation ws "}"',
		`decision ::= ${decision}`,
		'optional-message ::= ( ws "," ws "\\"messageToUser\\"" ws ":" ws jsonstring )?',
		'optional-clipboard ::= ( ws "," ws "\\"copyToClipboard\\"" ws ":" ws clipboard )?',
		'optional-recommendation ::= ( ws "," ws "\\"recommendedToolCallId\\"" ws ":" ws jsonstring )?',
		'clipboard ::= "{" ws "\\"title\\"" ws ":" ws jsonstring ws "," ws "\\"content\\"" ws ":" ws jsonstring clipboard-tags ws "}"',
		'clipboard-tags ::= ( ws "," ws "\\"tags\\"" ws ":" ws jsonstringarray )?',
		'jsonstringarray ::= "[" ws ( jsonstring ( ws "," ws jsonstring )* )? ws "]"',
		'jsonbool ::= "true" | "false"',
		'jsonstring ::= "\\"" ( [^"\\\\\\n\\r\\t] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] ) )* "\\""',
		"ws ::= [ \\t\\n\\r]*",
	].join("\n");
}

export function buildEvaluatorGuidance(): EvaluatorGuidance {
	const spans: ResponseSkeletonSpan[] = [
		{ kind: "literal", value: '{\n  "success": ' },
		{ kind: "boolean", key: "success", rule: "jsonbool" },
		{ kind: "literal", value: ',\n  "decision": ' },
		{
			kind: "enum",
			key: "decision",
			enumValues: [...DECISIONS],
			rule: "decision",
		},
		{ kind: "literal", value: ',\n  "thought": ' },
		{ kind: "free-string", key: "thought", rule: "jsonstring" },
		{ kind: "literal", value: "\n}" },
	];
	return {
		responseSkeleton: {
			id: "evaluator-v1",
			spans,
		},
		grammar: buildEvaluatorGrammar(),
		spanSamplerPlan: buildEvaluatorSpanSamplerPlan(spans),
	};
}

function buildEvaluatorSpanSamplerPlan(
	spans: readonly ResponseSkeletonSpan[],
): SpanSamplerPlan {
	const overrides: SpanSamplerOverride[] = [];
	for (let index = 0; index < spans.length; index += 1) {
		const span = spans[index];
		if (span.kind === "boolean" || span.kind === "enum") {
			overrides.push({ spanIndex: index, temperature: 0, topK: 1 });
		}
	}
	return { overrides };
}

function guidedDecodeEnabledByDefault(): boolean {
	const raw = (
		process.env.MILADY_LOCAL_GUIDED_DECODE ??
		process.env.ELIZA_LOCAL_GUIDED_DECODE ??
		""
	)
		.trim()
		.toLowerCase();
	return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function withEvaluatorGuidedDecodeProviderOptions<
	T extends Record<string, unknown>,
>(providerOptions: T): T {
	if (!guidedDecodeEnabledByDefault()) return providerOptions;
	const existingEliza =
		(providerOptions as { eliza?: Record<string, unknown> }).eliza ?? {};
	(providerOptions as { eliza?: Record<string, unknown> }).eliza = {
		...existingEliza,
		guidedDecode: true,
	};
	return providerOptions;
}

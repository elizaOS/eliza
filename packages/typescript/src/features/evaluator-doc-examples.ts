import type { EvaluatorDocExample } from "../generated/action-docs.ts";
import type { EvaluationExample } from "../types/index.ts";

export function toEvaluationExamples(
	examples: readonly EvaluatorDocExample[] | undefined,
): EvaluationExample[] {
	return (examples ?? []).map((example) => ({
		prompt: example.prompt,
		outcome: example.outcome,
		messages: example.messages.map((message) => ({
			name: message.name,
			content: {
				text: message.content.text,
				...(message.content.type ? { type: message.content.type } : {}),
			},
		})),
	}));
}

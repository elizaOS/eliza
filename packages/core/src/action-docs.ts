import {
	allActionDocs,
	allEvaluatorDocs,
	allProviderDocs,
} from "./generated/action-docs.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionParameterSchema,
	EvaluationExample,
	Evaluator,
	Provider,
} from "./types/index.ts";
import { compressPromptDescription } from "./utils/prompt-compression.ts";

type CompressedDescriptionFields = {
	description?: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
};

function resolveCompressedDescription(
	source: CompressedDescriptionFields,
	fallbackDescription: string,
	canonical?: CompressedDescriptionFields,
): string {
	return (
		source.descriptionCompressed ??
		source.compressedDescription ??
		canonical?.descriptionCompressed ??
		canonical?.compressedDescription ??
		compressPromptDescription(fallbackDescription)
	);
}

type ActionDocByName = Record<string, (typeof allActionDocs)[number]>;

const coreActionDocByName: ActionDocByName =
	allActionDocs.reduce<ActionDocByName>((acc, doc) => {
		acc[doc.name] = doc;
		return acc;
	}, {});

function cloneActionParameterSchema(
	schema: NonNullable<
		(typeof allActionDocs)[number]["parameters"]
	>[number]["schema"],
): ActionParameterSchema {
	const properties = schema.properties
		? Object.fromEntries(
				Object.entries(schema.properties).map(([key, value]) => [
					key,
					cloneActionParameterSchema(value),
				]),
			)
		: undefined;

	return {
		...schema,
		enum: schema.enum ? [...schema.enum] : undefined,
		enumValues: schema.enum ? [...schema.enum] : undefined,
		properties,
		items: schema.items ? cloneActionParameterSchema(schema.items) : undefined,
		oneOf: schema.oneOf?.map(cloneActionParameterSchema),
		anyOf: schema.anyOf?.map(cloneActionParameterSchema),
	};
}

function toActionParameter(
	param: NonNullable<(typeof allActionDocs)[number]["parameters"]>[number],
): ActionParameter {
	return {
		name: param.name,
		description: param.description,
		descriptionCompressed: resolveCompressedDescription(
			param,
			param.description,
		),
		required: param.required,
		schema: cloneActionParameterSchema(param.schema),
		examples: param.examples ? [...param.examples] : undefined,
	};
}

function ensureParameterCompressed(
	parameters: ActionParameter[],
): ActionParameter[] {
	return parameters.map((p) => ({
		...p,
		descriptionCompressed: resolveCompressedDescription(p, p.description),
	}));
}

/**
 * Merge canonical docs (description/similes/parameters) into an action definition.
 *
 * This is additive and intentionally conservative:
 * - does not overwrite an existing action.description
 * - does not overwrite existing action.similes
 * - does not overwrite existing action.parameters
 *
 * Always fills `descriptionCompressed` (and parameter-level compressed descriptions)
 * when absent, matching Python `compress_prompt_description` so prompt compression
 * is on for every registered action — including plugins with no canonical spec row.
 */
export function withCanonicalActionDocs(action: Action): Action {
	const doc = coreActionDocByName[action.name];

	const mergedDescription =
		(doc ? action.description || doc.description : action.description) ?? "";

	const descriptionCompressed = resolveCompressedDescription(
		action,
		mergedDescription,
		doc,
	);

	if (!doc) {
		const parameters =
			(action.parameters?.length ?? 0)
				? ensureParameterCompressed(action.parameters ?? [])
				: action.parameters;
		return {
			...action,
			descriptionCompressed,
			parameters,
		};
	}

	const parameters =
		action.parameters && action.parameters.length > 0
			? ensureParameterCompressed(action.parameters)
			: (doc.parameters ?? []).map(toActionParameter);

	return {
		...action,
		description: action.description || doc.description,
		descriptionCompressed,
		similes:
			action.similes && action.similes.length > 0
				? action.similes
				: doc.similes
					? [...doc.similes]
					: undefined,
		parameters,
	};
}

export function withCanonicalActionDocsAll(
	actions: readonly Action[],
): Action[] {
	return actions.map(withCanonicalActionDocs);
}

type ProviderDocByName = Record<string, (typeof allProviderDocs)[number]>;

const providerDocByName = allProviderDocs.reduce<ProviderDocByName>(
	(acc, doc) => {
		acc[doc.name] = doc;
		return acc;
	},
	{},
);

export function withCanonicalProviderDocs(provider: Provider): Provider {
	const doc = providerDocByName[provider.name];
	const description = provider.description || doc?.description || "";
	const descriptionCompressed = resolveCompressedDescription(
		provider,
		description,
		doc,
	);

	return {
		...provider,
		description: provider.description || doc?.description,
		descriptionCompressed,
	};
}

export function withCanonicalProviderDocsAll(
	providers: readonly Provider[],
): Provider[] {
	return providers.map(withCanonicalProviderDocs);
}

type EvaluatorDocByName = Record<string, (typeof allEvaluatorDocs)[number]>;

const coreEvaluatorDocByName: EvaluatorDocByName =
	allEvaluatorDocs.reduce<EvaluatorDocByName>((acc, doc) => {
		acc[doc.name] = doc;
		return acc;
	}, {});

function toEvaluationExample(
	ex: NonNullable<(typeof allEvaluatorDocs)[number]["examples"]>[number],
): EvaluationExample {
	const messages: ActionExample[] = (ex.messages ?? []).map((m) => ({
		name: m.name,
		content: {
			text: m.content.text,
			type: m.content.type,
		},
	}));

	return {
		prompt: ex.prompt,
		messages,
		outcome: ex.outcome,
	};
}

/**
 * Merge canonical docs (description/similes/examples) into an evaluator definition.
 *
 * This is additive and intentionally conservative:
 * - does not overwrite an existing evaluator.description
 * - does not overwrite existing evaluator.similes
 * - does not overwrite existing evaluator.examples (when non-empty)
 */
export function withCanonicalEvaluatorDocs(evaluator: Evaluator): Evaluator {
	const doc = coreEvaluatorDocByName[evaluator.name];
	const description = evaluator.description || doc?.description || "";
	const descriptionCompressed = resolveCompressedDescription(
		evaluator,
		description,
		doc,
	);

	if (!doc) {
		return {
			...evaluator,
			descriptionCompressed,
		};
	}

	const examples =
		evaluator.examples && evaluator.examples.length > 0
			? evaluator.examples
			: (doc.examples ?? []).map(toEvaluationExample);

	return {
		...evaluator,
		description: evaluator.description || doc.description,
		descriptionCompressed,
		similes:
			evaluator.similes && evaluator.similes.length > 0
				? evaluator.similes
				: doc.similes
					? [...doc.similes]
					: undefined,
		examples,
	};
}

export function withCanonicalEvaluatorDocsAll(
	evaluators: readonly Evaluator[],
): Evaluator[] {
	return evaluators.map(withCanonicalEvaluatorDocs);
}

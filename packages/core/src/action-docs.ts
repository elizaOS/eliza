import { allActionDocs, allProviderDocs } from "./generated/action-docs.ts";
import type {
	Action,
	ActionParameter,
	ActionParameterSchema,
	JsonValue,
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

function cloneDocExampleValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneActionParameterSchema(
	schema: NonNullable<
		(typeof allActionDocs)[number]["parameters"]
	>[number]["schema"],
): ActionParameterSchema {
	const { default: schemaDefault, ...restSchema } = schema;
	const properties = schema.properties
		? Object.fromEntries(
				Object.entries(schema.properties).map(([key, value]) => [
					key,
					cloneActionParameterSchema(value),
				]),
			)
		: undefined;

	return {
		...restSchema,
		default:
			schemaDefault === undefined
				? undefined
				: cloneDocExampleValue(schemaDefault),
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
		examples: param.examples?.map(cloneDocExampleValue),
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

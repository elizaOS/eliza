/** Normalizes character input, message examples, knowledge/documents, and content before validation. */
import {
	type CharacterValidationResult,
	validateCharacter,
} from "./character-schema";
import type {
	Character,
	CharacterSettings,
	MessageExample,
	MessageExampleGroup,
	TemplateType,
} from "./types/agent.js";
import type { DocumentSourceItem } from "./types/documents.js";
import { isObjectRecord as isRecord } from "./utils/type-guards";

type CharacterDocumentItem =
	| string
	| { path: string; shared?: boolean }
	| { directory: string; shared?: boolean }
	| DocumentSourceItem;

type MessageExamplesInput = MessageExampleGroup[] | MessageExample[][];

export interface CharacterInput {
	id?: string;
	name?: string;
	username?: string;
	system?: string;
	templates?: Record<string, TemplateType>;
	bio?: string | string[];
	messageExamples?: MessageExamplesInput;
	postExamples?: string[];
	topics?: string[];
	adjectives?: string[];
	documents?: CharacterDocumentItem[];
	knowledge?: CharacterDocumentItem[];
	plugins?: string[];
	settings?: CharacterSettings;
	secrets?: Record<string, string>;
	style?: { all?: string[]; chat?: string[]; post?: string[] };
	advancedPlanning?: boolean;
	advancedMemory?: boolean;
}

interface NormalizedCharacterInput {
	id?: string;
	name?: string;
	username?: string;
	system?: string;
	templates: Record<string, TemplateType>;
	bio: string[];
	messageExamples: MessageExampleGroup[];
	postExamples: string[];
	topics: string[];
	adjectives: string[];
	documents: DocumentSourceItem[];
	plugins: string[];
	settings?: CharacterSettings;
	secrets: Record<string, string>;
	style?: { all?: string[]; chat?: string[]; post?: string[] };
	advancedPlanning?: boolean;
	advancedMemory?: boolean;
}

const isMessageExampleGroup = (
	value: MessageExampleGroup | MessageExample[],
): value is MessageExampleGroup =>
	isRecord(value) && "examples" in value && Array.isArray(value.examples);

function normalizeMessageExamples(
	input?: MessageExamplesInput,
): MessageExampleGroup[] {
	if (!input || input.length === 0) return [];
	const first = input[0];
	if (Array.isArray(first)) {
		const exampleSets = input as MessageExample[][];
		return exampleSets.map((examples) => ({ examples }));
	}
	if (isMessageExampleGroup(first)) {
		return input as MessageExampleGroup[];
	}
	return [];
}

function normalizeDocumentItem(
	item: CharacterDocumentItem,
): DocumentSourceItem | null {
	if (typeof item === "string") {
		return { item: { case: "path", value: item } };
	}
	if (!isRecord(item)) {
		return null;
	}
	if ("item" in item && isRecord(item.item)) {
		const caseValue = item.item.case;
		if (caseValue === "path" && typeof item.item.value === "string") {
			return item as DocumentSourceItem;
		}
		if (
			caseValue === "directory" &&
			isRecord(item.item.value) &&
			typeof item.item.value.path === "string"
		) {
			return item as DocumentSourceItem;
		}
	}
	if ("path" in item && typeof item.path === "string") {
		return { item: { case: "path", value: item.path } };
	}
	if ("directory" in item && typeof item.directory === "string") {
		return {
			item: {
				case: "directory",
				value: {
					path: item.directory,
					shared: typeof item.shared === "boolean" ? item.shared : undefined,
				},
			},
		};
	}
	return null;
}

export function normalizeCharacterInput(
	input: CharacterInput,
): NormalizedCharacterInput {
	const bioValue = input.bio;
	const normalizedBio =
		bioValue === undefined
			? []
			: Array.isArray(bioValue)
				? bioValue
				: [bioValue];

	const documentInput = [
		...(input.documents ?? []),
		...(input.knowledge ?? []),
	];
	const normalizedDocuments = documentInput
		.map((item) => normalizeDocumentItem(item))
		.filter((item): item is DocumentSourceItem => item !== null);

	return {
		id: input.id,
		name: input.name,
		username: input.username,
		system: input.system,
		templates: input.templates ?? {},
		bio: normalizedBio,
		messageExamples: normalizeMessageExamples(input.messageExamples),
		postExamples: input.postExamples ?? [],
		topics: input.topics ?? [],
		adjectives: input.adjectives ?? [],
		documents: normalizedDocuments,
		plugins: input.plugins ?? [],
		settings: input.settings ?? {},
		secrets: input.secrets ?? {},
		style: input.style,
		advancedPlanning: input.advancedPlanning,
		advancedMemory: input.advancedMemory,
	};
}

export function createCharacter(
	input: CharacterInput & { name: string },
): Character {
	return normalizeCharacterInput(input) as Character;
}

function formatValidationErrors(
	error: CharacterValidationResult["error"],
): string[] {
	return error?.issues
		? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
		: [error?.message || "Unknown validation error"];
}

export function parseCharacter(
	input: string | object | Character | CharacterInput,
): Character {
	if (typeof input === "string") {
		throw new Error(
			`Character path provided but must be loaded first: ${input}`,
		);
	}

	if (typeof input === "object") {
		const normalized =
			input && typeof input === "object"
				? normalizeCharacterInput(input as CharacterInput)
				: input;
		const validationResult = validateCharacter(normalized);

		if (!validationResult.success) {
			throw new Error(
				`Character validation failed: ${formatValidationErrors(validationResult.error).join("; ")}`,
			);
		}

		return validationResult.data as Character;
	}

	throw new Error("Invalid character input format");
}

export function validateCharacterConfig(character: Character): {
	isValid: boolean;
	errors: string[];
} {
	const validationResult = validateCharacter(character);

	if (validationResult.success) {
		return {
			isValid: true,
			errors: [],
		};
	}

	return {
		isValid: false,
		errors: formatValidationErrors(validationResult.error),
	};
}

export function mergeCharacterDefaults(char: CharacterInput): Character {
	const normalized = normalizeCharacterInput(char);
	return {
		...normalized,
		name: normalized.name || "Unnamed Character",
	} as Character;
}

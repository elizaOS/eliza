import { logger } from "../../../../logger.ts";
import type { Character } from "../../../../types/agent.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import { persistCharacterPatch } from "./shared/persist-character-patch.ts";

type PersistCharacterParameters = {
	fieldsToSave?: unknown;
};

const SAVEABLE_CHARACTER_FIELDS: ReadonlyArray<keyof Character> = [
	"name",
	"username",
	"system",
	"bio",
	"adjectives",
	"topics",
	"style",
	"messageExamples",
	"postExamples",
	"templates",
	"settings",
	"plugins",
	"documents",
] as const;

function normalizeFieldList(value: unknown): Array<keyof Character> {
	if (!Array.isArray(value)) return [];
	const valid = new Set<string>(SAVEABLE_CHARACTER_FIELDS as readonly string[]);
	const seen = new Set<string>();
	const out: Array<keyof Character> = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!valid.has(trimmed) || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed as keyof Character);
	}
	return out;
}

/**
 * Persist the current in-memory `runtime.character` to the
 * `eliza_character_persistence` service — the same save path used by the
 * UI's CharacterEditor. By default writes every saveable field; pass
 * `fieldsToSave` to limit to a specific subset.
 *
 * Useful when other actions have mutated `runtime.character` directly and
 * a single persist call should commit the result.
 */
export const persistCharacterAction: Action = {
	name: "PERSIST_CHARACTER",
	contexts: ["settings", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"SAVE_CHARACTER",
		"COMMIT_CHARACTER",
		"FLUSH_CHARACTER",
		"WRITE_CHARACTER",
	],
	description:
		"Persists the in-memory runtime character to the standard character persistence service (config + agent storage + history). Optionally limit the save to specific fields via fieldsToSave.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "fieldsToSave",
			description:
				"Optional list of character fields to persist. Allowed values: name, username, system, bio, adjectives, topics, style, messageExamples, postExamples, templates, settings, plugins, knowledge. If omitted, all saveable fields are persisted.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContextOrKeyword(message, state, {
			contexts: ["settings", "agent_internal"],
			keywords: [
				"persist character",
				"save character",
				"commit character",
				"write character",
				"save personality",
			],
		}),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as PersistCharacterParameters;
		const requestedFields = normalizeFieldList(params.fieldsToSave);

		try {
			const fieldsToPersist =
				requestedFields.length > 0
					? requestedFields
					: SAVEABLE_CHARACTER_FIELDS.filter(
							(field) => runtime.character[field] !== undefined,
						);

			const patch: Partial<Character> = {};
			for (const field of fieldsToPersist) {
				const value = runtime.character[field];
				if (value !== undefined) {
					(patch as Record<string, unknown>)[field as string] = value;
				}
			}

			if (Object.keys(patch).length === 0) {
				const text = "No character fields to persist.";
				await callback?.({ text, thought: "Empty patch — nothing to save" });
				return {
					text,
					success: true,
					values: { fieldsPersisted: [] },
					data: { action: "PERSIST_CHARACTER" },
				};
			}

			const result = await persistCharacterPatch(runtime, patch);
			if (!result.success) {
				const text = `I couldn't persist the character: ${result.error ?? "unknown error"}`;
				await callback?.({ text, thought: "Character persistence failed" });
				return {
					text,
					success: false,
					values: { error: result.error ?? "persistence_failed" },
					data: { action: "PERSIST_CHARACTER" },
				};
			}

			const persistedFields = Object.keys(patch);
			const summary = `Persisted ${persistedFields.length} character field(s): ${persistedFields.join(", ")}.`;
			await callback?.({
				text: summary,
				thought: `Persisted character fields: ${persistedFields.join(", ")}`,
				actions: ["PERSIST_CHARACTER"],
			});

			return {
				text: summary,
				success: true,
				values: {
					fieldsPersisted: persistedFields,
					count: persistedFields.length,
				},
				data: {
					action: "PERSIST_CHARACTER",
					persistData: { fields: persistedFields },
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in PERSIST_CHARACTER action",
			);
			const text = "I encountered an error while persisting the character.";
			await callback?.({
				text,
				thought: `Error in persist character: ${(error as Error).message}`,
			});
			return {
				text,
				success: false,
				values: { error: (error as Error).message },
				data: {
					action: "PERSIST_CHARACTER",
					errorDetails: (error as Error).stack,
				},
			};
		}
	},

	examples: [
		[
			{
				name: "{{user}}",
				content: { text: "Save the character." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Persisted 8 character field(s): name, bio, topics, style, messageExamples, postExamples, settings, adjectives.",
					actions: ["PERSIST_CHARACTER"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: { text: "Save just the bio and topics." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Persisted 2 character field(s): bio, topics.",
					actions: ["PERSIST_CHARACTER"],
				},
			},
		],
	] as ActionExample[][],
};

/**
 * Action specs for clipboard actions (inlined from plugin-clipboard generated specs)
 */

export interface ActionSpec {
	name: string;
	description: string;
	similes?: string[];
	examples?: Array<Array<{ role: string; content: string }>>;
}

export const actionSpecs: Record<string, ActionSpec> = {
	CLIPBOARD_WRITE: {
		name: "CLIPBOARD_WRITE",
		description:
			"Write a new note or memory to the clipboard. Use this to save information for later retrieval.",
		similes: [
			"SAVE_NOTE",
			"CREATE_NOTE",
			"WRITE_NOTE",
			"REMEMBER_THIS",
			"SAVE_MEMORY",
			"JOT_DOWN",
			"NOTE_THIS",
		],
		examples: [
			[
				{
					role: "user",
					content:
						"Please save a note about the meeting tomorrow at 3pm with John about the marketing strategy.",
				},
				{
					role: "assistant",
					content:
						"I've saved a note about your meeting. Title: 'Meeting with John - Marketing Strategy'. You can retrieve it later.",
				},
			],
			[
				{
					role: "user",
					content:
						"Remember that the API key for the service is stored in the .env file.",
				},
				{
					role: "assistant",
					content:
						"I've noted that the API key is stored in the .env file. I'll remember this for future reference.",
				},
			],
		],
	},

	CLIPBOARD_READ: {
		name: "CLIPBOARD_READ",
		description:
			"Read the content of a specific clipboard entry. Use after searching to retrieve full details.",
		similes: [
			"GET_NOTE",
			"READ_NOTE",
			"RETRIEVE_NOTE",
			"GET_MEMORY",
			"FETCH_NOTE",
			"OPEN_NOTE",
		],
		examples: [
			[
				{
					role: "user",
					content: "Can you show me the note about the marketing meeting?",
				},
				{
					role: "assistant",
					content:
						"Here's the note 'Meeting with John - Marketing Strategy': Meeting scheduled for tomorrow at 3pm...",
				},
			],
		],
	},

	CLIPBOARD_SEARCH: {
		name: "CLIPBOARD_SEARCH",
		description:
			"Search through clipboard entries for relevant information. Returns matching snippets with relevance scores.",
		similes: [
			"FIND_NOTE",
			"SEARCH_NOTES",
			"LOOKUP_MEMORY",
			"FIND_MEMORY",
			"SEARCH_MEMORY",
			"RECALL",
		],
		examples: [
			[
				{
					role: "user",
					content: "What notes do I have about marketing?",
				},
				{
					role: "assistant",
					content:
						"I found 2 clipboard entries mentioning marketing: 1) 'Meeting with John - Marketing Strategy' (score: 0.85)...",
				},
			],
		],
	},

	CLIPBOARD_LIST: {
		name: "CLIPBOARD_LIST",
		description:
			"List all clipboard entries with their titles and modification dates.",
		similes: [
			"SHOW_NOTES",
			"LIST_NOTES",
			"ALL_NOTES",
			"MY_NOTES",
			"SHOW_MEMORIES",
		],
		examples: [
			[
				{
					role: "user",
					content: "Show me all my saved notes.",
				},
				{
					role: "assistant",
					content:
						"You have 5 clipboard entries: 1) Meeting notes (modified today), 2) API documentation (modified yesterday)...",
				},
			],
		],
	},

	CLIPBOARD_DELETE: {
		name: "CLIPBOARD_DELETE",
		description: "Delete a clipboard entry by its ID.",
		similes: [
			"REMOVE_NOTE",
			"DELETE_NOTE",
			"FORGET_NOTE",
			"ERASE_NOTE",
			"REMOVE_MEMORY",
		],
		examples: [
			[
				{
					role: "user",
					content: "Delete the note about the old meeting.",
				},
				{
					role: "assistant",
					content:
						"I've deleted the clipboard entry 'old-meeting'. The note has been removed.",
				},
			],
		],
	},

	CLIPBOARD_APPEND: {
		name: "CLIPBOARD_APPEND",
		description: "Append additional content to an existing clipboard entry.",
		similes: [
			"ADD_TO_NOTE",
			"UPDATE_NOTE",
			"APPEND_NOTE",
			"EXTEND_NOTE",
			"ADD_MORE",
		],
		examples: [
			[
				{
					role: "user",
					content: "Add to the meeting notes that we decided on a $50k budget.",
				},
				{
					role: "assistant",
					content:
						"I've appended the budget decision to the meeting notes. The note now includes the $50k budget information.",
				},
			],
		],
	},
};

export function requireActionSpec(name: string): ActionSpec {
	const spec = actionSpecs[name];
	if (!spec) {
		throw new Error(`Action spec not found: ${name}`);
	}
	return spec;
}

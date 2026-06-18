/**
 * Serialize an interaction block back to its bracket-marker wire form. The
 * inverse of `parse` for the text-borne blocks (form / choice / followups /
 * task); lets an action build a block programmatically and emit it without
 * hand-writing markers. `secret` blocks have no text form (they travel via the
 * sensitive-request dispatch registry) and serialize to an empty string.
 */

import type {
	ChoiceInteraction,
	FollowupsInteraction,
	FormInteraction,
	InteractionBlock,
	TaskInteraction,
} from "../../types/interactions";

function serializeForm(block: FormInteraction): string {
	const body = {
		id: block.id,
		...(block.title ? { title: block.title } : {}),
		...(block.description ? { description: block.description } : {}),
		...(block.submitLabel ? { submitLabel: block.submitLabel } : {}),
		fields: block.fields,
	};
	return `[FORM]\n${JSON.stringify(body)}\n[/FORM]`;
}

function serializeChoice(block: ChoiceInteraction): string {
	const lines = block.options.map((o) => `${o.value}=${o.label}`).join("\n");
	const flags = block.allowCustom ? " allow_custom" : "";
	return `[CHOICE:${block.scope} id=${block.id}${flags}]\n${lines}\n[/CHOICE]`;
}

function serializeFollowups(block: FollowupsInteraction): string {
	const lines = block.options
		.map(
			(o) =>
				`${o.kind === "reply" ? o.payload : `${o.kind}:${o.payload}`}=${o.label}`,
		)
		.join("\n");
	return `[FOLLOWUPS id=${block.id}]\n${lines}\n[/FOLLOWUPS]`;
}

function serializeTask(block: TaskInteraction): string {
	return `[TASK:${block.threadId}]${block.title}[/TASK]`;
}

/** Serialize a block to its wire marker. `secret` blocks return "". */
export function serializeInteractionBlock(block: InteractionBlock): string {
	switch (block.kind) {
		case "form":
			return serializeForm(block);
		case "choice":
			return serializeChoice(block);
		case "followups":
			return serializeFollowups(block);
		case "task":
			return serializeTask(block);
		case "secret":
			return "";
		default: {
			const _exhaustive: never = block;
			return _exhaustive;
		}
	}
}

/** Append a block's marker to `text` (with a separating blank line when needed). */
export function appendInteractionBlock(
	text: string,
	block: InteractionBlock,
): string {
	const marker = serializeInteractionBlock(block);
	if (!marker) return text;
	if (!text.trim()) return marker;
	return `${text.replace(/\s+$/, "")}\n\n${marker}`;
}

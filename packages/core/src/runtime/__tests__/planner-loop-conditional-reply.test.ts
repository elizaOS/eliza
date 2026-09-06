/**
 * Exercises real planner post-navigation reply delivery with deterministic model
 * responses. Conditional requests for user input preserve complete explanations,
 * while unconditional or already-running action claims remain blocked.
 */
import { describe, expect, it } from "vitest";
import {
	runPlannerLoop,
	TURN_SCOPE_ARG,
	TURN_SCOPE_FINAL,
} from "../planner-loop";

async function deliver(reply: string) {
	let calls = 0;
	let navigations = 0;
	const result = await runPlannerLoop({
		runtime: {
			useModel: async () =>
				calls++ === 0
					? {
							text: "",
							toolCalls: [
								{
									id: "notes",
									name: "VIEWS",
									arguments: {
										action: "show",
										view: "notes",
										[TURN_SCOPE_ARG]: TURN_SCOPE_FINAL,
									},
								},
							],
						}
					: { text: reply, toolCalls: [] },
		},
		context: { id: "conditional-follow-up" },
		tools: [
			{ name: "VIEWS", description: "Open the requested writing surface." },
		],
		executeToolCall: async () => {
			navigations++;
			return {
				success: true,
				text: '{"effect":"view_navigation","status":"accepted"}',
				transcriptVisibility: "internal",
				modelReplyRequired: true,
			};
		},
		evaluate: async () => {
			throw new Error("Final navigation should not need an evaluator");
		},
	});
	return { result, navigations, calls };
}

describe("conditional offers after completed navigation", () => {
	it.each([
		"If you have a first thought in mind, tell me what to write and I'll put it up now.",
		"Once you choose a title, I will save the note.",
		`Just say "note that..." and I'll write it down.`,
		"Tell me what to write and I'll save the note.",
		"Please choose a title and I will save it.",
		"You can keep writing here; I’ll save it once you confirm.",
	])(
		"preserves the complete explanation and user-dependent offer: %s",
		async (offer) => {
			const reply = `Notes is open. You can create, search, recolor, and delete notes. Your writing persists across sessions.\n\n${offer}`;
			const { result, navigations, calls } = await deliver(reply);
			expect(result.finalMessage).toBe(reply);
			expect(navigations).toBe(1);
			expect(calls).toBe(2);
		},
	);
	it.each([
		"I'll save a note now.",
		"I’ll save a note now.",
		`Just say "note that..." and I'll save it and I will send your notes now.`,
		'The phrase "If you tell me" appears in my notes and I will send them now.',
		'Just say "save it". I will send your notes now.',
		"You can tell me later and I will send your notes now.",
		"I will send your notes now and I will save a copy once you confirm.",
		"I will save a copy once you confirm and I will send your notes now.",
		"If you share the title, I will save it and I will send your notes now.",
		"If you like the workspace, I'll send your notes now.",
		"If you want a note, tell me. I'll save it now.",
		"If you want a note, tell me; I'll save it now.",
		"If you share a title, I'll save it. I'm fetching your private messages now.",
	])(
		"does not let a conditional phrase excuse unsupported work: %s",
		async (claim) => {
			const reply = `Notes is open. ${claim}`;
			const { result, navigations } = await deliver(reply);
			expect(result.finalMessage).not.toContain(claim);
			expect(result.finalMessage).toBe("The requested action completed.");
			expect(navigations).toBe(1);
		},
	);
});

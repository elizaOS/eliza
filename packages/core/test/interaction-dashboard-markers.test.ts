import { describe, expect, it } from "vitest";
import { stripDashboardOnlyMarkers } from "../src/messaging/interaction-dashboard-markers.ts";
import { renderInteractionsAsPlainText } from "../src/messaging/interaction-layout.ts";
import { parseInteractionBlocks } from "../src/messaging/interaction-parse.ts";

const checklistJson =
	'{"title":"Today","items":[{"content":"Buy milk","status":"completed"},{"content":"Call mom"}]}';
const workflowJson =
	'{"title":"Deploy","steps":[{"label":"Build","status":"done"},{"label":"Ship"}]}';
const checklistText = "Today:\n- [x] Buy milk\n- [ ] Call mom";
const workflowText = "Deploy:\n1. Build — done\n2. Ship — pending";

describe("dashboard widget blocks on connector text", () => {
	it("degrades an LF checklist block", () => {
		expect(
			parseInteractionBlocks(
				`Here is your plan:\n[CHECKLIST]\n${checklistJson}\n[/CHECKLIST]`,
			).cleanedText,
		).toBe(`Here is your plan:\n${checklistText}`);
	});

	it("degrades a checklist block with CRLF line endings", () => {
		expect(
			parseInteractionBlocks(
				`Here is your plan:\r\n[CHECKLIST]\r\n${checklistJson}\r\n[/CHECKLIST]`,
			).cleanedText,
		).toBe(`Here is your plan:\r\n${checklistText}`);
	});

	it("degrades checklist markers with the spacing the dashboard accepts", () => {
		for (const [opening, closing] of [
			["[CHECKLIST] ", "[/CHECKLIST]"],
			["[ CHECKLIST ]", "[ / CHECKLIST ]"],
			["[CHECKLIST]\t", "[/CHECKLIST\t]"],
		]) {
			expect(
				renderInteractionsAsPlainText(
					`Here is your plan:\n${opening}\n${checklistJson}\n${closing}`,
				).text,
			).toBe(`Here is your plan:\n${checklistText}`);
		}
	});

	it("degrades a workflow block with CRLF line endings", () => {
		expect(
			stripDashboardOnlyMarkers(
				`Pipeline:\r\n[WORKFLOW]\r\n${workflowJson}\r\n[/WORKFLOW]`,
			),
		).toBe(`Pipeline:\r\n${workflowText}`);
	});
});

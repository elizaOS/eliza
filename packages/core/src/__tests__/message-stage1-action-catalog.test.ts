/**
 * Shape of the Stage-1 `available_actions` discovery catalog: one
 * `NAME: description` line per action, complete descriptions, no JSON.
 * Pure function, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	formatAvailableActionsForPrompt,
	stage1RoutingDescription,
} from "../services/message/context-assembly";

// Live owner-catalog descriptions (2026-09-14).
const TRIGGER_DESCRIPTION =
	"Recurring/scheduled trigger lifecycle AND user reminders. Action-based dispatch (create / update / delete / run / toggle / list). Use toggle to PAUSE or RESUME a reminder ('pause the X reminder', 'resume X', 'turn X back on', 'stop reminding me about X') — pausing keeps the trigger and is not a delete. Use create for 'remind me in N minutes/at TIME to …' and any scheduled prompt. Use list for 'what reminders do I have' / 'when does my next reminder fire' — reminders are NOT calendar events and never appear in the calendar feed. Use run to fire one immediately. Use update to change schedule or instruction.";
const TASKS_DESCRIPTION =
	"Planner surface for orchestrator workspace operations and coding task delegation to dedicated ACP coding sub-agents (elizaos / pi-agent / claude / codex). Available operations (pick via `action`): create or spawn_agent (delegate new coding work), send (forward a message to an existing coding sub-agent), list (show sessions), status (one session), cancel (stop a session), workspace_create, workspace_list, workspace_delete, workspace_status, workspace_diff, workspace_files, workspace_read, workspace_write, workspace_exec. Choose this when the user asks to delegate coding work, use a coding adapter by name, or run multi-step development work — it is the canonical path for coding sub-agents. NOT for building a web app/page/site/interactive HTML the user wants hosted with a live link — that is APP action=create, which builds, verifies, AND publishes; a task workspace has no hosting path, so files built here never get a URL.";
const CONTACT_DESCRIPTION =
	"Manage Rolodex contacts. Action-based dispatch — provide an `action` parameter: create   — create a new contact (name required; optional email/phone/notes/categories/tags). read     — load full identity, facts, recent conversations, and relationships by entityId or name. search   — search contacts by name/handle/platform; line-numbered results. update   — update entity-level fields (name/email/phone/notes), contact_info (categories/tags/preferences/customFields), or component data per source (UPDATE_ENTITY semantics). delete   — permanently delete a contact (entityId or name; requires confirm:true).";
const BROWSER_DESCRIPTION =
	"BROWSER action. Control registered browser target: app workspace, bridge Chrome/Firefox/Safari companion, computeruse Chromium, or Stagehand fallback. BrowserService picks target if omitted. Read the current page with action=snapshot (page text and elements) or action=state (page state). action=get reads one element and requires selector; it does not read the whole page when selector is omitted. Interaction: click, type (append), fill (replace), clear, press, scroll (direction/pixels, optional selector), hover, drag (selector -> targetSelector).";

describe("stage1RoutingDescription", () => {
	it("renders a description within the cap complete", () => {
		const description =
			"Search the open web for current or external information using keyless MCP search. Uses Parallel first and Exa fallback, returning complete ranked result text. For a live NOW-value (spot price, exchange rate, current weather) prefer WEB_FETCH to a live JSON endpoint — search snippets lag live values.";
		expect(stage1RoutingDescription(description)).toBe(description);
	});

	it("keeps the lead and the routing sentences of a long description and drops the operation list", () => {
		const trimmed = stage1RoutingDescription(TRIGGER_DESCRIPTION);
		expect(trimmed.startsWith("Recurring/scheduled trigger lifecycle AND user reminders.")).toBe(true);
		expect(trimmed).toContain("Use toggle to PAUSE or RESUME a reminder");
		expect(trimmed).toContain("reminders are NOT calendar events");
		expect(trimmed).not.toContain("Action-based dispatch");
		expect(trimmed).not.toContain("Use run to fire one immediately");
		expect(trimmed.length).toBeLessThanOrEqual(400);
		expect(trimmed.endsWith(".")).toBe(true);
	});

	it("keeps a disambiguation ahead of a positive cue when not everything fits", () => {
		const trimmed = stage1RoutingDescription(TASKS_DESCRIPTION);
		expect(trimmed.startsWith("Planner surface for orchestrator workspace operations")).toBe(true);
		expect(trimmed).toContain("NOT for building a web app/page/site/interactive HTML");
		expect(trimmed).not.toContain("Available operations");
		expect(trimmed).not.toContain("Choose this when");
		expect(trimmed.length).toBeLessThanOrEqual(400);
	});

	it("skips a bare NAME action. label sentence", () => {
		const trimmed = stage1RoutingDescription(BROWSER_DESCRIPTION);
		expect(trimmed.startsWith("Control registered browser target:")).toBe(true);
		expect(trimmed).not.toContain("BROWSER action.");
		expect(trimmed).not.toContain("action=snapshot");
	});

	it("falls back to the leading sentences when routing cues leave too little, and 'preferences' is not a cue", () => {
		const trimmed = stage1RoutingDescription(CONTACT_DESCRIPTION);
		expect(trimmed.startsWith("Manage Rolodex contacts. Action-based dispatch")).toBe(true);
		expect(trimmed).not.toContain("update entity-level fields");
		expect(trimmed.length).toBeGreaterThanOrEqual(120);
		expect(trimmed.length).toBeLessThanOrEqual(401);
	});

	it("cuts an over-long lead sentence at a word boundary with an ellipsis", () => {
		const lead = `Polymorphic runtime control; ${"action=status snapshots registered actions providers services ".repeat(8)}and more`;
		const trimmed = stage1RoutingDescription(lead);
		expect(trimmed.length).toBeLessThanOrEqual(401);
		expect(trimmed.endsWith("…")).toBe(true);
		expect(trimmed).not.toMatch(/\s…$/);
	});

	it("keeps a sentence made of quoted user phrasings", () => {
		const description = `Owner-only polymorphic settings action. ${"Dispatches on action to read/list/change built-in settings sections and more knobs. ".repeat(6)}'turn off shell access', 'what settings can you change', 'switch the brain to cerebras'.`;
		expect(description.length).toBeGreaterThan(400);
		const trimmed = stage1RoutingDescription(description);
		expect(trimmed).toContain("'turn off shell access'");
		expect(trimmed).not.toContain("Dispatches on action");
	});
});

describe("formatAvailableActionsForPrompt", () => {
	it("renders one NAME: description line per action in catalog order", () => {
		const rendered = formatAvailableActionsForPrompt([
			{ name: "CALENDAR", description: "Calendar reads and writes." },
			{ name: "NOTES", description: "Sticky notes: create, list, update." },
		]);
		expect(rendered).toBe(
			"CALENDAR: Calendar reads and writes.\nNOTES: Sticky notes: create, list, update.",
		);
	});

	it("keeps the complete description and collapses embedded newlines", () => {
		// Live CONTACT description: a multi-line op table. Every word survives;
		// only the newline runs (and their indentation) become single spaces so
		// the catalog stays one line per action.
		const description =
			"Manage Rolodex contacts. Provide an `action` parameter:\n  create   — create a new contact.\n  read     — load a contact by id.";
		const rendered = formatAvailableActionsForPrompt([
			{ name: "CONTACT", description },
		]);
		expect(rendered).toBe(
			"CONTACT: Manage Rolodex contacts. Provide an `action` parameter: create   — create a new contact. read     — load a contact by id.",
		);
		for (const word of description.split(/\s+/)) {
			expect(rendered).toContain(word);
		}
	});

	it("does not quote or escape description text", () => {
		const rendered = formatAvailableActionsForPrompt([
			{ name: "ROOM", description: 'Use "scope=server" to mute a guild.' },
		]);
		expect(rendered).toBe('ROOM: Use "scope=server" to mute a guild.');
		expect(rendered).not.toContain('\\"');
	});

	it("renders a bare name when the description is empty", () => {
		expect(
			formatAvailableActionsForPrompt([{ name: "PING", description: "" }]),
		).toBe("PING");
	});

	it("renders the placeholder for an empty catalog", () => {
		expect(formatAvailableActionsForPrompt([])).toBe("(no actions available)");
	});
});

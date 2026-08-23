/**
 * Pins the connector-facing projection of dashboard-only reply markers:
 * bare `[CONFIG]`/`[CONNECTOR]`/`[BACKGROUND]` markers must vanish, and
 * `[CHECKLIST]`/`[WORKFLOW]` widget blocks must degrade to plain text that
 * keeps their content without leaking wire syntax to button-less transports.
 *
 * The harness is deterministic and pure: it drives the real module with
 * plain strings and asserts observable outputs, with no mocks and no
 * network or filesystem involvement.
 */

import { describe, expect, it } from "vitest";
import { stripDashboardOnlyMarkers } from "./dashboard-markers.ts";

describe("stripDashboardOnlyMarkers: fast path", () => {
	it("leaves prose without any dashboard marker untouched", () => {
		expect(stripDashboardOnlyMarkers("Hello there, agent.")).toBe(
			"Hello there, agent.",
		);
		expect(stripDashboardOnlyMarkers("")).toBe("");
	});

	it("leaves look-alike bracket text that is not a dashboard marker", () => {
		expect(stripDashboardOnlyMarkers("[CONFIGURE] me")).toBe("[CONFIGURE] me");
		expect(stripDashboardOnlyMarkers("[CHECKLISTS] nope")).toBe(
			"[CHECKLISTS] nope",
		);
		expect(stripDashboardOnlyMarkers("background job")).toBe("background job");
	});
});

describe("stripDashboardOnlyMarkers: bare markers", () => {
	it("removes CONFIG and CONNECTOR cards including scoped plugin ids", () => {
		expect(stripDashboardOnlyMarkers("See [CONFIG:google_calendars].")).toBe(
			"See .",
		);
		expect(
			stripDashboardOnlyMarkers("Use [CONNECTOR:@elizaos/plugin-discord] now."),
		).toBe("Use  now.");
	});

	it("removes every occurrence of each marker", () => {
		expect(stripDashboardOnlyMarkers("[CONFIG:a] mid [CONFIG:b:c/d] end")).toBe(
			"mid  end",
		);
		expect(stripDashboardOnlyMarkers("[CONNECTOR:a][CONNECTOR:b]")).toBe("");
	});

	it("removes the BACKGROUND picker marker", () => {
		expect(stripDashboardOnlyMarkers("Pick one: [BACKGROUND]")).toBe(
			"Pick one:",
		);
	});

	it("leaves an unterminated CONFIG prefix intact", () => {
		expect(stripDashboardOnlyMarkers("[CONFIG:")).toBe("[CONFIG:");
	});

	it("collapses whitespace orphaned by removed markers", () => {
		expect(
			stripDashboardOnlyMarkers("first line\n[BACKGROUND]\nsecond line"),
		).toBe("first line\n\nsecond line");
	});

	it("trims the final projection", () => {
		expect(stripDashboardOnlyMarkers("   [BACKGROUND] hello world ")).toBe(
			"hello world",
		);
	});
});

function checklist(items: unknown, title?: unknown): string {
	const body: Record<string, unknown> = { items };
	if (title !== undefined) {
		body.title = title;
	}
	return `[CHECKLIST]\n${JSON.stringify(body)}\n[/CHECKLIST]`;
}

function workflow(steps: unknown, title?: unknown): string {
	const body: Record<string, unknown> = { steps };
	if (title !== undefined) {
		body.title = title;
	}
	return `[WORKFLOW]\n${JSON.stringify(body)}\n[/WORKFLOW]`;
}

describe("stripDashboardOnlyMarkers: CHECKLIST projection", () => {
	it("projects items onto task-list lines with status glyphs", () => {
		const text = [
			"Here is your plan:",
			checklist([
				{ content: "  alpha  ", status: "completed" },
				{ content: "beta", status: "in_progress" },
				{ content: "gamma", status: "pending" },
			]),
			"Done.",
		].join("\n");
		expect(stripDashboardOnlyMarkers(text)).toBe(
			"Here is your plan:\n- [x] alpha\n- [~] beta\n- [ ] gamma\nDone.",
		);
	});

	it("defaults unknown and missing statuses to pending", () => {
		const text = checklist([
			{ content: "one", status: "bogus-status" },
			{ content: "two" },
		]);
		expect(stripDashboardOnlyMarkers(text)).toBe("- [ ] one\n- [ ] two");
	});

	it("keeps the title when present and omits it otherwise", () => {
		expect(
			stripDashboardOnlyMarkers(checklist([{ content: "a" }], "  Chores  ")),
		).toBe("Chores:\n- [ ] a");
		expect(
			stripDashboardOnlyMarkers(checklist([{ content: "a" }], "   ")),
		).toBe("- [ ] a");
		expect(stripDashboardOnlyMarkers(checklist([{ content: "a" }]))).toBe(
			"- [ ] a",
		);
	});

	it("skips entries without usable content", () => {
		const text = checklist([
			"just a string",
			null,
			{ status: "completed" },
			{ content: "   " },
			{ content: 42 },
			{ content: "real" },
		]);
		expect(stripDashboardOnlyMarkers(text)).toBe("- [ ] real");
	});

	it("falls back to the raw body when no item survives", () => {
		const body = JSON.stringify({ items: [{ content: "" }] });
		const text = `[CHECKLIST]\n${body}\n[/CHECKLIST]`;
		expect(stripDashboardOnlyMarkers(text)).toBe(body);
	});

	it("degrades a malformed checklist body to its text without markers", () => {
		const text = "[CHECKLIST]\nnot json at all\n[/CHECKLIST]";
		expect(stripDashboardOnlyMarkers(text)).toBe("not json at all");
	});

	it("treats non-object JSON bodies as malformed", () => {
		expect(stripDashboardOnlyMarkers("[CHECKLIST]\n[1,2]\n[/CHECKLIST]")).toBe(
			"[1,2]",
		);
		expect(
			stripDashboardOnlyMarkers('[CHECKLIST]\n"a string"\n[/CHECKLIST]'),
		).toBe('"a string"');
	});
});

describe("stripDashboardOnlyMarkers: WORKFLOW projection", () => {
	it("projects steps onto numbered lines carrying their status", () => {
		const text = workflow([
			{ label: " Fetch data ", status: "done" },
			{ label: "Transform", status: "in progress" },
			{ label: "Load" },
			{ label: "  ", status: "skipped" },
		]);
		expect(stripDashboardOnlyMarkers(text)).toBe(
			"1. Fetch data — done\n2. Transform — in progress\n3. Load — pending",
		);
	});

	it("supports workflow titles", () => {
		expect(
			stripDashboardOnlyMarkers(workflow([{ label: "step" }], "Pipeline")),
		).toBe("Pipeline:\n1. step — pending");
	});

	it("falls back to the raw body when no step survives or JSON is malformed", () => {
		const body = JSON.stringify({ steps: [{ label: "" }] });
		expect(stripDashboardOnlyMarkers(`[WORKFLOW]\n${body}\n[/WORKFLOW]`)).toBe(
			body,
		);
		expect(stripDashboardOnlyMarkers("[WORKFLOW]\n}\n[/WORKFLOW]")).toBe("}");
	});
});

describe("stripDashboardOnlyMarkers: widget block boundaries", () => {
	it("preserves surrounding prose around degraded blocks", () => {
		const text = [
			"before",
			checklist([{ content: "task one" }], "Plan"),
			"middle",
			workflow([{ label: "step one" }], "Flow"),
			"after",
		].join("\n");
		expect(stripDashboardOnlyMarkers(text)).toBe(
			[
				"before",
				"Plan:\n- [ ] task one",
				"middle",
				"Flow:\n1. step one — pending",
				"after",
			].join("\n"),
		);
	});

	it("leaves an unterminated widget block completely untouched", () => {
		const text = '[CHECKLIST]\n{"items":[]}';
		expect(stripDashboardOnlyMarkers(text)).toBe(text);
	});

	it("preserves an unterminated tail after a completed block", () => {
		const good = checklist([{ content: "a" }]);
		const text = `${good}\ntail [WORKFLOW]\nnever closed`;
		expect(stripDashboardOnlyMarkers(text)).toBe(
			`- [ ] a\ntail [WORKFLOW]\nnever closed`,
		);
	});
});

describe("stripDashboardOnlyMarkers: combinations", () => {
	it("cleans mixed marker kinds in one pass", () => {
		const text = [
			"[CONFIG:google_calendars]",
			checklist([{ content: "ship it", status: "completed" }], "Release"),
			"[CONNECTOR:discord]",
			"[BACKGROUND]",
		].join("\n");
		expect(stripDashboardOnlyMarkers(text)).toBe("Release:\n- [x] ship it");
	});

	it("is idempotent", () => {
		const text = `Intro [CONFIG:abc]\n${checklist([{ content: "x" }], "T")}`;
		const once = stripDashboardOnlyMarkers(text);
		expect(stripDashboardOnlyMarkers(once)).toBe(once);
	});
});

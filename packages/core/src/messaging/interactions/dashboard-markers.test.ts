/**
 * Unit tests for dashboard markers: verifies stripping of CONFIG, CONNECTOR,
 * and BACKGROUND markers, and degradation of CHECKLIST and WORKFLOW blocks.
 */
import { describe, expect, it } from "vitest";
import { stripDashboardOnlyMarkers } from "./dashboard-markers.ts";

describe("dashboard-markers", () => {
	it("returns untouched text when no markers are present", () => {
		const input = "Hello world, here is some plain text.";
		expect(stripDashboardOnlyMarkers(input)).toBe(input);
	});

	it("strips bare CONFIG, CONNECTOR, and BACKGROUND markers", () => {
		const text =
			"Prefix [CONFIG:google_calendars] [CONNECTOR:telegram] [BACKGROUND] Suffix";
		const cleaned = stripDashboardOnlyMarkers(text);
		expect(cleaned).toContain("Prefix");
		expect(cleaned).toContain("Suffix");
		expect(cleaned).not.toContain("[CONFIG:google_calendars]");
		expect(cleaned).not.toContain("[CONNECTOR:telegram]");
		expect(cleaned).not.toContain("[BACKGROUND]");
	});

	it("degrades valid CHECKLIST JSON block to plain task list", () => {
		const text = `Here is your checklist:
[CHECKLIST]
{
  "title": "Onboarding Tasks",
  "items": [
    { "content": "Set up account", "status": "completed" },
    { "content": "Verify email", "status": "in_progress" },
    { "content": "Complete profile", "status": "pending" }
  ]
}
[/CHECKLIST]
Done.`;

		const cleaned = stripDashboardOnlyMarkers(text);
		expect(cleaned).toContain("Onboarding Tasks:");
		expect(cleaned).toContain("- [x] Set up account");
		expect(cleaned).toContain("- [~] Verify email");
		expect(cleaned).toContain("- [ ] Complete profile");
		expect(cleaned).not.toContain("[CHECKLIST]");
	});

	it("degrades valid WORKFLOW JSON block to numbered steps", () => {
		const text = `Deployment workflow:
[WORKFLOW]
{
  "title": "Release Pipeline",
  "steps": [
    { "label": "Lint & Typecheck", "status": "passed" },
    { "label": "Unit Tests", "status": "running" }
  ]
}
[/WORKFLOW]`;

		const cleaned = stripDashboardOnlyMarkers(text);
		expect(cleaned).toContain("Release Pipeline:");
		expect(cleaned).toContain("1. Lint & Typecheck — passed");
		expect(cleaned).toContain("2. Unit Tests — running");
		expect(cleaned).not.toContain("[WORKFLOW]");
	});

	it("handles malformed widget JSON blocks gracefully", () => {
		const text = `Invalid checklist:
[CHECKLIST]
{ not valid json }
[/CHECKLIST]`;
		const cleaned = stripDashboardOnlyMarkers(text);
		expect(cleaned).toContain("{ not valid json }");
		expect(cleaned).not.toContain("[CHECKLIST]");
	});
});

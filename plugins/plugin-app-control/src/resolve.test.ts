/**
 * App and run-name resolution tests for exact, fuzzy, and ambiguous targets.
 */

import { describe, expect, it } from "vitest";
import {
	formatAppCandidates,
	formatRunCandidates,
	resolveInstalledApp,
	resolveRunByName,
} from "./resolve.js";
import type { AppRunSummary, InstalledAppInfo } from "./types.js";

const app = (over: Partial<InstalledAppInfo>): InstalledAppInfo =>
	({ name: "", displayName: "", pluginName: "", ...over }) as InstalledAppInfo;

const run = (over: Partial<AppRunSummary>): AppRunSummary =>
	({
		appName: "",
		displayName: "",
		pluginName: "",
		runId: "",
		status: "running",
		...over,
	}) as AppRunSummary;

const calc = app({
	name: "calc",
	displayName: "Calculator",
	pluginName: "@x/calc",
});
const notes = app({
	name: "notes",
	displayName: "Notes",
	pluginName: "@x/notes",
});

describe("resolveInstalledApp", () => {
	it("matches exactly (case-insensitive) on name, displayName, or pluginName", () => {
		expect(resolveInstalledApp("CALC", [calc, notes])).toMatchObject({
			kind: "match",
			match: calc,
		});
		expect(resolveInstalledApp("calculator", [calc, notes]).match).toBe(calc);
		expect(resolveInstalledApp("@x/notes", [calc, notes]).match).toBe(notes);
	});

	it("returns none for no match or an empty needle", () => {
		expect(resolveInstalledApp("zzz", [calc, notes]).kind).toBe("none");
		expect(resolveInstalledApp("  ", [calc, notes]).kind).toBe("none");
	});

	it("falls back to a unique substring match", () => {
		expect(resolveInstalledApp("alc", [calc, notes])).toMatchObject({
			kind: "match",
			match: calc,
		});
	});

	it("reports ambiguity when a substring hits multiple apps", () => {
		const calendar = app({ name: "calendar", displayName: "Calendar" });
		const r = resolveInstalledApp("cal", [calc, calendar]);
		expect(r.kind).toBe("ambiguous");
		expect(r.candidates).toHaveLength(2);
	});

	it("prefers an exact match over substring rivals", () => {
		const cal = app({ name: "cal", displayName: "Cal" });
		// "cal" is an exact name of `cal` and a substring of `calc` — exact wins.
		expect(resolveInstalledApp("cal", [cal, calc])).toMatchObject({
			kind: "match",
			match: cal,
		});
	});
});

describe("resolveRunByName", () => {
	it("matches on runId as well as the name fields", () => {
		const r1 = run({
			appName: "calc",
			displayName: "Calculator",
			runId: "r-123",
		});
		const r2 = run({ appName: "notes", displayName: "Notes", runId: "r-456" });
		expect(resolveRunByName("r-123", [r1, r2]).match).toBe(r1);
		expect(resolveRunByName("notes", [r1, r2]).match).toBe(r2);
		expect(resolveRunByName("nope", [r1, r2]).kind).toBe("none");
	});
});

describe("candidate formatting", () => {
	it("formats app and run candidate lists", () => {
		expect(formatAppCandidates([calc])).toBe("- Calculator (calc)");
		expect(
			formatRunCandidates([
				run({ displayName: "Calculator", runId: "r-1", status: "running" }),
			]),
		).toBe("- Calculator [runId: r-1, status: running]");
	});
});
/**
 * App and run-name resolution tests for exact, fuzzy, and ambiguous targets.
 */

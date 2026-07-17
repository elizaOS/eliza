/**
 * App and run-name resolution tests for exact, fuzzy, and ambiguous targets.
 */

import { describe, expect, it } from "vitest";
import {
	formatAppCandidates,
	resolveInstalledApp,
} from "./resolve.js";
import type { InstalledAppInfo } from "./types.js";

const app = (over: Partial<InstalledAppInfo>): InstalledAppInfo =>
	({ name: "", displayName: "", pluginName: "", ...over }) as InstalledAppInfo;

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

describe("candidate formatting", () => {
	it("formats the app candidate list", () => {
		expect(formatAppCandidates([calc])).toBe("- Calculator (calc)");
	});
});
/**
 * App and run-name resolution tests for exact, fuzzy, and ambiguous targets.
 */

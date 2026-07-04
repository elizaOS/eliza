/**
 * Exercises view-kind resolution and gating — `resolveViewKind` (including the
 * legacy `developerOnly` mapping), `isViewKindEnabled`, `isViewVisible`, and the
 * `VIEW_KIND_META` table over the closed `VIEW_KINDS` set. Deterministic
 * assertions with no model or database in the loop.
 */
import { describe, expect, it } from "vitest";
import {
	type EnabledViewKinds,
	isAlwaysOnViewKind,
	isViewKindEnabled,
	isViewVisible,
	resolveViewKind,
	VIEW_KIND_META,
	VIEW_KINDS,
} from "./view-kind";

const NONE: EnabledViewKinds = { developer: false, preview: false };
const DEV: EnabledViewKinds = { developer: true, preview: false };
const PREVIEW: EnabledViewKinds = { developer: false, preview: true };
const ALL: EnabledViewKinds = { developer: true, preview: true };

describe("resolveViewKind", () => {
	it("uses an explicit viewKind when present", () => {
		expect(resolveViewKind({ viewKind: "system" })).toBe("system");
		expect(resolveViewKind({ viewKind: "preview" })).toBe("preview");
	});

	it("explicit viewKind wins over legacy developerOnly", () => {
		expect(resolveViewKind({ viewKind: "release", developerOnly: true })).toBe(
			"release",
		);
	});

	it("maps legacy developerOnly:true to developer", () => {
		expect(resolveViewKind({ developerOnly: true })).toBe("developer");
	});

	it("defaults to release", () => {
		expect(resolveViewKind({})).toBe("release");
		expect(resolveViewKind(undefined)).toBe("release");
		expect(resolveViewKind(null)).toBe("release");
		expect(resolveViewKind({ developerOnly: false })).toBe("release");
	});
});

describe("isViewKindEnabled", () => {
	it("system and release are always enabled", () => {
		for (const enabled of [NONE, DEV, PREVIEW, ALL]) {
			expect(isViewKindEnabled("system", enabled)).toBe(true);
			expect(isViewKindEnabled("release", enabled)).toBe(true);
		}
	});

	it("developer follows the developer toggle", () => {
		expect(isViewKindEnabled("developer", NONE)).toBe(false);
		expect(isViewKindEnabled("developer", DEV)).toBe(true);
		expect(isViewKindEnabled("developer", PREVIEW)).toBe(false);
	});

	it("preview follows the preview toggle", () => {
		expect(isViewKindEnabled("preview", NONE)).toBe(false);
		expect(isViewKindEnabled("preview", DEV)).toBe(false);
		expect(isViewKindEnabled("preview", PREVIEW)).toBe(true);
	});
});

describe("isViewVisible", () => {
	it("gates declarations end-to-end via their resolved kind", () => {
		expect(isViewVisible({ viewKind: "system" }, NONE)).toBe(true);
		expect(isViewVisible({ developerOnly: true }, NONE)).toBe(false);
		expect(isViewVisible({ developerOnly: true }, DEV)).toBe(true);
		expect(isViewVisible({ viewKind: "preview" }, DEV)).toBe(false);
		expect(isViewVisible({ viewKind: "preview" }, ALL)).toBe(true);
		expect(isViewVisible(undefined, NONE)).toBe(true); // defaults to release
	});
});

describe("metadata", () => {
	it("isAlwaysOnViewKind marks only system + release", () => {
		expect(isAlwaysOnViewKind("system")).toBe(true);
		expect(isAlwaysOnViewKind("release")).toBe(true);
		expect(isAlwaysOnViewKind("developer")).toBe(false);
		expect(isAlwaysOnViewKind("preview")).toBe(false);
	});

	it("VIEW_KIND_META covers every kind with consistent alwaysOn flags", () => {
		for (const kind of VIEW_KINDS) {
			const meta = VIEW_KIND_META[kind];
			expect(meta.label.length).toBeGreaterThan(0);
			expect(meta.description.length).toBeGreaterThan(0);
			expect(meta.alwaysOn).toBe(isAlwaysOnViewKind(kind));
		}
	});
});

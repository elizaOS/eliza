/**
 * Core context routing gates which actions/providers are surfaced each turn.
 * shouldIncludeByContext is permissive by design (no declared or no active
 * contexts → include) but otherwise requires an overlap, so a context-scoped
 * action only appears in its context. inferContextRoutingFromText scores the
 * message text into a primary context (general when nothing matches).
 */

import { describe, expect, it } from "vitest";
import type { Action, Provider } from "../types/components";
import {
	deriveAvailableContexts,
	getActiveRoutingContexts,
	inferContextRoutingFromText,
	routingContextsOverlap,
	shouldIncludeByContext,
} from "./context-routing.ts";

const action = (name: string, contexts?: string[]): Action =>
	({ name, ...(contexts ? { contexts } : {}) }) as unknown as Action;

describe("routingContextsOverlap", () => {
	it("is true only when the two sets share a context (case-insensitive)", () => {
		expect(routingContextsOverlap(["code", "browser"], ["BROWSER"])).toBe(true);
		expect(routingContextsOverlap(["code"], ["browser"])).toBe(false);
		expect(routingContextsOverlap(["code"], [])).toBe(false);
		expect(routingContextsOverlap(undefined, ["code"])).toBe(false);
	});
});

describe("shouldIncludeByContext", () => {
	it("includes when declared or active is empty (permissive default)", () => {
		expect(shouldIncludeByContext(undefined, ["code"])).toBe(true);
		expect(shouldIncludeByContext([], ["code"])).toBe(true);
		expect(shouldIncludeByContext(["wallet"], [])).toBe(true);
	});

	it("otherwise requires an overlap", () => {
		expect(shouldIncludeByContext(["wallet"], ["wallet", "general"])).toBe(
			true,
		);
		expect(shouldIncludeByContext(["wallet"], ["code"])).toBe(false);
	});
});

describe("getActiveRoutingContexts", () => {
	it("adds general alongside primary + secondary, empty for an empty decision", () => {
		expect(
			getActiveRoutingContexts({
				primaryContext: "code",
				secondaryContexts: ["browser"],
			}).sort(),
		).toEqual(["browser", "code", "general"]);
		expect(getActiveRoutingContexts({})).toEqual([]);
	});
});

describe("deriveAvailableContexts", () => {
	it("collects declared action contexts, always includes general, sorted", () => {
		const got = deriveAvailableContexts(
			[action("A", ["browser"]), action("B", ["code"])],
			[] as Provider[],
		);
		expect(got).toContain("general");
		expect(got).toContain("browser");
		expect(got).toContain("code");
		expect([...got]).toEqual([...got].sort());
	});
});

describe("inferContextRoutingFromText", () => {
	it("infers code intent from repo/fix language", () => {
		expect(
			inferContextRoutingFromText("can you fix the bug in the repository")
				.primaryContext,
		).toBe("code");
	});

	it("infers browser intent from navigation language", () => {
		expect(
			inferContextRoutingFromText(
				"navigate to the website and click the button",
			).primaryContext,
		).toBe("browser");
	});

	it("falls back to general for chit-chat / empty", () => {
		expect(
			inferContextRoutingFromText("good morning friend").primaryContext,
		).toBe("general");
		expect(inferContextRoutingFromText("").primaryContext).toBe("general");
	});
});

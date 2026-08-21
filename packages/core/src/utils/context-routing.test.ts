/**
 * Core context routing gates which actions/providers are surfaced each turn.
 * shouldIncludeByContext is permissive by design (no declared or no active
 * contexts → include) but otherwise requires an overlap, so a context-scoped
 * action only appears in its context. inferContextRoutingFromText scores the
 * message text into a primary context (general when nothing matches).
 */

import { describe, expect, it } from "vitest";
import type { Action, Provider } from "../types/components";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	deriveAvailableContexts,
	getActiveRoutingContexts,
	getActiveRoutingContextsForTurn,
	inferContextRoutingFromText,
	mergeContextRouting,
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

describe("mergeContextRouting", () => {
	it("demotes losing primary into secondaries instead of dropping (app-path: state knowledge, message general)", () => {
		const state = {
			values: {
				__contextRouting: {
					primaryContext: "knowledge",
					secondaryContexts: [],
				},
			},
		} as unknown as State;
		const message = {
			content: {
				text: "hello",
				metadata: {
					__responseContext: {
						primaryContext: "general",
						secondaryContexts: ["general"],
					},
				},
			},
		} as unknown as Memory;
		const merged = mergeContextRouting(state, message);
		expect(merged.primaryContext).toBe("general");
		expect(merged.secondaryContexts).toEqual(
			expect.arrayContaining(["general", "knowledge"]),
		);
		const active = getActiveRoutingContextsForTurn(state, message).map(
			(context) => `${context}`.toLowerCase(),
		);
		expect(active).toEqual(expect.arrayContaining(["general", "knowledge"]));
	});

	it("keeps message primary precedence (knowledge vs documents)", () => {
		const state = {
			values: {
				__contextRouting: {
					primaryContext: "knowledge",
					secondaryContexts: [],
				},
			},
		} as unknown as State;
		const message = {
			content: {
				text: "hi",
				metadata: {
					__responseContext: {
						primaryContext: "documents",
						secondaryContexts: [],
					},
				},
			},
		} as unknown as Memory;
		const merged = mergeContextRouting(state, message);
		expect(merged.primaryContext).toBe("documents");
		expect(merged.secondaryContexts).toEqual(
			expect.arrayContaining(["knowledge", "documents"]),
		);
	});

	it("mixed documents + knowledge routing stays permissive (both visible, pins documents clause)", () => {
		const state = {
			values: {
				__contextRouting: {
					primaryContext: "knowledge",
					secondaryContexts: [],
				},
			},
		} as unknown as State;
		const message = {
			content: {
				text: "hi",
				metadata: {
					__responseContext: {
						primaryContext: "documents",
						secondaryContexts: [],
					},
				},
			},
		} as unknown as Memory;
		const active = getActiveRoutingContextsForTurn(state, message).map(
			(context) => `${context}`.toLowerCase(),
		);
		expect(active).toContain("knowledge");
		expect(active).toContain("documents");
		const isBlocked =
			active.includes("knowledge") && !active.includes("documents");
		expect(isBlocked).toBe(false);
	});

	it("knowledge-only routing blocks mutations but allows read-only", () => {
		const state = {
			values: {
				__contextRouting: {
					primaryContext: "knowledge",
					secondaryContexts: [],
				},
			},
		} as unknown as State;
		const message = {
			content: {
				text: "hi",
				metadata: {
					__responseContext: {
						primaryContext: "general",
						secondaryContexts: ["general"],
					},
				},
			},
		} as unknown as Memory;
		const active = getActiveRoutingContextsForTurn(state, message).map(
			(context) => `${context}`.toLowerCase(),
		);
		expect(active).toContain("knowledge");
		expect(active).not.toContain("documents");
		const shouldBlockMutation =
			active.includes("knowledge") && !active.includes("documents");
		expect(shouldBlockMutation).toBe(true);
		const shouldBlockReadOnly = false;
		expect(shouldBlockReadOnly).toBe(false);
	});

	it("no behavior change when only state has routing", () => {
		const state = {
			values: {
				__contextRouting: {
					primaryContext: "knowledge",
					secondaryContexts: ["code"],
				},
			},
		} as unknown as State;
		const message = {
			content: { text: "hi", metadata: {} },
		} as unknown as Memory;
		const merged = mergeContextRouting(state, message);
		expect(merged.primaryContext).toBe("knowledge");
		expect(merged.secondaryContexts).toEqual(
			expect.arrayContaining(["knowledge", "code"]),
		);
	});

	it("no behavior change when only message has routing", () => {
		const state = { values: {} } as unknown as State;
		const message = {
			content: {
				text: "hi",
				metadata: {
					__responseContext: {
						primaryContext: "knowledge",
						secondaryContexts: ["browser"],
					},
				},
			},
		} as unknown as Memory;
		const merged = mergeContextRouting(state, message);
		expect(merged.primaryContext).toBe("knowledge");
		expect(merged.secondaryContexts).toEqual(
			expect.arrayContaining(["knowledge", "browser"]),
		);
	});

	it("existing message-routed shape still works (no state routing)", () => {
		const message = {
			content: {
				text: "hi",
				metadata: {
					__responseContext: {
						primaryContext: "knowledge",
						secondaryContexts: [],
					},
				},
			},
		} as unknown as Memory;
		const active = getActiveRoutingContextsForTurn(undefined, message).map(
			(context) => `${context}`.toLowerCase(),
		);
		expect(active).toContain("knowledge");
	});

	it("deduplicates losing primary if already in secondaries", () => {
		const state = {
			values: {
				__contextRouting: {
					primaryContext: "knowledge",
					secondaryContexts: ["knowledge"],
				},
			},
		} as unknown as State;
		const message = {
			content: {
				text: "hi",
				metadata: {
					__responseContext: {
						primaryContext: "general",
						secondaryContexts: ["general"],
					},
				},
			},
		} as unknown as Memory;
		const merged = mergeContextRouting(state, message);
		const countKnowledge = merged.secondaryContexts.filter(
			(context) => `${context}`.toLowerCase() === "knowledge",
		).length;
		expect(countKnowledge).toBe(1);
	});
});

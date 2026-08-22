/**
 * Validates `DEFAULT_CONTEXT_DEFINITIONS`: unique ids and required fields, clean
 * idempotent registration into a `ContextRegistry`, role-scoped
 * `listAvailable` filtering (OWNER-only vs USER vs GUEST contexts), and the
 * channel-history routing vocabulary the Stage-1 catalog must keep on the
 * `general` line so group-chat recap asks can route to the room-scoped
 * CHANNEL_RECAP surface. Pure, no model.
 */
import { describe, expect, it } from "vitest";
import { formatAvailableContextsForPrompt } from "../../services/message";
import { ContextRegistry } from "../context-registry";
import {
	DEFAULT_CONTEXT_DEFINITIONS,
	getDefaultContextDefinitions,
} from "../default-contexts";

describe("default-contexts", () => {
	it("has unique ids", () => {
		const ids = DEFAULT_CONTEXT_DEFINITIONS.map((definition) => definition.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("each definition has at minimum the required ContextDefinition fields", () => {
		for (const definition of DEFAULT_CONTEXT_DEFINITIONS) {
			expect(typeof definition.id).toBe("string");
			expect(definition.id.length).toBeGreaterThan(0);
			expect(typeof definition.label).toBe("string");
			expect(typeof definition.description).toBe("string");
			expect(definition.description?.length).toBeGreaterThan(0);
		}
	});

	it("registers cleanly into a fresh ContextRegistry and round-trips through list()", () => {
		const registry = new ContextRegistry([]);
		const { added, skipped } = registry.tryRegisterMany(
			DEFAULT_CONTEXT_DEFINITIONS,
		);
		expect(added.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
		expect(skipped).toEqual([]);

		const listed = registry.list();
		expect(listed.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
		for (const definition of DEFAULT_CONTEXT_DEFINITIONS) {
			expect(registry.has(definition.id)).toBe(true);
		}
	});

	it("tryRegisterMany is idempotent on duplicate ids", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);
		const { added, skipped } = registry.tryRegisterMany(
			DEFAULT_CONTEXT_DEFINITIONS,
		);
		expect(added).toEqual([]);
		expect(skipped.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
	});

	it("listAvailable filters out OWNER-only contexts for USER role", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);

		const userContexts = registry
			.listAvailable("USER")
			.map((definition) => definition.id);

		// `secrets`, `admin`, `agent_internal`, `health`, `terminal`, `screen_time`,
		// `subscriptions`, `payments`, and `wallet` are OWNER-only per PLAN.md §4.3.
		const ownerOnly = [
			"secrets",
			"admin",
			"agent_internal",
			"health",
			"terminal",
			"screen_time",
			"subscriptions",
			"payments",
			"wallet",
		];
		for (const id of ownerOnly) {
			expect(userContexts).not.toContain(id);
		}

		// `general`, `web`, `memory`, `documents`, and `media` are USER-or-below.
		expect(userContexts).toEqual(
			expect.arrayContaining([
				"general",
				"web",
				"memory",
				"documents",
				"media",
			]),
		);
	});

	it("listAvailable for OWNER includes every context", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);

		const ownerContexts = registry.listAvailable("OWNER");
		expect(ownerContexts.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
	});

	it("listAvailable for GUEST includes only ungated public contexts", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);

		const guestContexts = registry
			.listAvailable("GUEST")
			.map((definition) => definition.id);
		// `general` is the canonical GUEST context.
		expect(guestContexts).toContain("general");
		// USER-gated contexts are excluded from GUEST.
		expect(guestContexts).not.toContain("memory");
		expect(guestContexts).not.toContain("documents");
	});
});

describe("general context channel-history routing vocabulary", () => {
	// Live 2026-08-21 root cause: a Discord group sender asked "what were last
	// like 100 messages in this chat summary>" and Stage 1 routed
	// contexts=["general"], but the general catalog line carried no
	// channel-history vocabulary and the surface had no message-history tool,
	// so the planner honestly refused. The catalog renders the complete
	// description, which must keep carrying this vocabulary (same contract as
	// the #17059 tasks recap line).
	it("keeps recap/summary phrasings for the current chat in the general line", () => {
		const catalog = formatAvailableContextsForPrompt(
			getDefaultContextDefinitions(),
		);
		const generalLine = catalog
			.split("\n")
			.find((line) => line.startsWith("- general"));
		expect(generalLine).toBeDefined();
		expect(generalLine).toMatch(/summarize this chat/i);
		expect(generalLine).toMatch(/recap the channel/i);
		expect(generalLine).toMatch(/what were the last 100 messages/i);
		expect(generalLine).toMatch(/what did people say here earlier/i);
	});

	it("names the room-scoped surface and keeps cross-channel work in messaging", () => {
		const definition = DEFAULT_CONTEXT_DEFINITIONS.find(
			(entry) => entry.id === "general",
		);
		expect(definition).toBeDefined();
		expect(definition?.description).toMatch(/CHANNEL_RECAP/);
		expect(definition?.description).toMatch(
			/cross-channel or inbox-wide message work stays in messaging/i,
		);
		expect(definition?.descriptionCompressed).toMatch(
			/current-channel history/i,
		);
	});
});

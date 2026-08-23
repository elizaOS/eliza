/**
 * Exercises the real deferred capability catalog and per-turn session with
 * deterministic actions/providers/contexts. The tests prove explicit
 * continuation, catalog-bound loads, same-session activation, context
 * expansion, and the absence of metadata that was not admitted by the caller.
 */
import { describe, expect, it } from "vitest";
import type { Action, Provider } from "../types/components";
import type { ContextDefinition } from "../types/contexts";
import {
	buildPlannerCapabilityCatalog,
	DISCOVER_CAPABILITIES_TOOL,
	PlannerCapabilityDiscoverySession,
} from "./capability-discovery";

function action(input: {
	name: string;
	description: string;
	contexts?: string[];
	similes?: string[];
}): Action {
	return {
		name: input.name,
		description: input.description,
		descriptionCompressed: input.description,
		contexts: input.contexts,
		similes: input.similes,
		parameters: [
			{
				name: "value",
				description: `Value for ${input.name}`,
				required: true,
				schema: { type: "string" },
			},
		],
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
}

function provider(input: {
	name: string;
	description: string;
	contexts?: string[];
}): Provider {
	return {
		name: input.name,
		description: input.description,
		contexts: input.contexts,
		get: async () => ({ text: input.description }),
	};
}

const contexts: ContextDefinition[] = [
	{
		id: "calendar",
		description: "Calendar events, availability, and scheduling.",
		aliases: ["schedule"],
	},
	{
		id: "email",
		description: "Email messages and inbox operations.",
		aliases: ["mail"],
	},
];

describe("planner capability discovery", () => {
	it("keeps non-admitted metadata out of the authorization-filtered catalog", () => {
		const allowed = action({
			name: "CALENDAR_READ",
			description: "Read calendar events",
			contexts: ["calendar"],
		});
		const denied = action({
			name: "OWNER_SECRET_EXPORT",
			description: "Private owner export",
			contexts: ["secrets"],
		});
		const catalog = buildPlannerCapabilityCatalog({
			actions: [allowed],
			contexts,
		});

		expect(catalog.records.map((record) => record.name)).toContain(
			allowed.name,
		);
		expect(JSON.stringify(catalog)).not.toContain(denied.name);
		expect(JSON.stringify(catalog)).not.toContain(denied.description);
	});

	it("returns an explicit continuation and activates search-matched actions", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [
				action({
					name: "CALENDAR_READ",
					description: "Read calendar schedule and events",
					contexts: ["calendar"],
				}),
				action({
					name: "EMAIL_SEARCH",
					description: "Search email messages and inbox",
					contexts: ["email"],
				}),
			],
			contexts,
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });

		const first = session.execute({
			operation: "search",
			query: "calendar email",
			kinds: ["action"],
			limit: 1,
		});

		expect(first.items).toHaveLength(1);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toEqual(expect.any(String));
		expect(first.matchedCount).toBe(2);
		expect(first.activated.actions).toEqual([first.items[0].name]);
		expect(session.toolForAction(first.items[0].name)).toBeDefined();
		expect(JSON.stringify(first.items)).not.toContain("parameters");

		const second = session.execute({
			operation: "search",
			query: "calendar email",
			kinds: ["action"],
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(second.items).toHaveLength(1);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeNull();
		expect(new Set(session.activeActionNames)).toEqual(
			new Set(["CALENDAR_READ", "EMAIL_SEARCH"]),
		);
	});

	it("loads a context and expands its authorized actions and providers", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [
				action({
					name: "CALENDAR_READ",
					description: "Read calendar events",
					contexts: ["calendar"],
				}),
				action({
					name: "EMAIL_SEARCH",
					description: "Search email messages",
					contexts: ["email"],
				}),
			],
			providers: [
				provider({
					name: "CALENDAR_STATE",
					description: "Current calendar state",
					contexts: ["calendar"],
				}),
			],
			contexts,
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });
		const loaded = session.execute({
			operation: "load",
			catalogHash: catalog.hash,
			refs: ["context:calendar"],
		});

		expect(loaded.activated.contexts).toEqual(["calendar"]);
		expect(loaded.activated.actions).toEqual(["CALENDAR_READ"]);
		expect(loaded.activated.providers).toEqual(["CALENDAR_STATE"]);
		expect(session.activeActionNames.has("EMAIL_SEARCH")).toBe(false);
	});

	it("requires the current catalog hash for exact loads", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [action({ name: "READ", description: "Read a resource" })],
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });

		expect(() =>
			session.execute({
				operation: "load",
				catalogHash: "stale",
				refs: ["action:READ"],
			}),
		).toThrow(/current catalogHash/);
		expect(session.activeActionNames.size).toBe(0);
	});

	it("binds continuation cursors to the exact search request", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [
				action({ name: "CALENDAR_READ", description: "Read calendar events" }),
				action({
					name: "CALENDAR_WRITE",
					description: "Write calendar events",
				}),
				action({ name: "EMAIL_READ", description: "Read email messages" }),
			],
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });
		const first = session.execute({
			operation: "search",
			query: "calendar",
			limit: 1,
		});

		expect(() =>
			session.execute({
				operation: "search",
				query: "email",
				limit: 1,
				cursor: first.nextCursor ?? undefined,
			}),
		).toThrow(/invalid or stale/);
	});

	it("restores append-only activation state after an external activation failure", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [action({ name: "READ", description: "Read a resource" })],
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });
		const snapshot = session.snapshot();
		session.execute({
			operation: "load",
			catalogHash: catalog.hash,
			refs: ["action:READ"],
		});
		session.restore(snapshot);

		expect(session.activeActionNames.size).toBe(0);
	});

	it("does not run or auto-load provider matches during search", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [],
			providers: [
				provider({
					name: "INBOX_STATE",
					description: "Email inbox state and unread messages",
					contexts: ["email"],
				}),
			],
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });
		const result = session.execute({
			operation: "search",
			query: "unread email",
		});

		expect(result.items[0]?.kind).toBe("provider");
		expect(result.activated.providers).toEqual([]);
		expect(session.activeProviderNames.size).toBe(0);
	});

	it("exposes an explicit paginated discovery schema", () => {
		expect(DISCOVER_CAPABILITIES_TOOL.name).toBe("DISCOVER_CAPABILITIES");
		expect(DISCOVER_CAPABILITIES_TOOL.description).toContain("hasMore");
		expect(DISCOVER_CAPABILITIES_TOOL.description).toContain("nextCursor");
	});
});

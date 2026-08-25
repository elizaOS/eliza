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
	it("keeps legacy registered actions without descriptions discoverable", () => {
		const legacyAction = {
			...action({ name: "LEGACY_TOOL", description: "placeholder" }),
			description: undefined,
			descriptionCompressed: undefined,
		} as unknown as Action;
		const catalog = buildPlannerCapabilityCatalog({
			actions: [legacyAction],
		});
		const record = catalog.byRef.get("action:LEGACY_TOOL");

		expect(record?.summary).toBe("Run the LEGACY_TOOL action.");
		expect(record?.tool?.description).toBe("Run the LEGACY_TOOL action.");
		expect(
			new PlannerCapabilityDiscoverySession({ catalog }).execute({
				operation: "search",
				query: "legacy tool",
				kinds: ["action"],
			}),
		).toMatchObject({
			items: [{ ref: "action:LEGACY_TOOL" }],
			activated: { actions: ["LEGACY_TOOL"] },
		});
	});

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

	it("activates a discovered action's context and providers without loading sibling actions", () => {
		const catalog = buildPlannerCapabilityCatalog({
			actions: [
				action({
					name: "CALENDAR_READ",
					description: "Read calendar events",
					contexts: ["calendar"],
				}),
				action({
					name: "CALENDAR_DELETE",
					description: "Delete calendar events",
					contexts: ["calendar"],
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
		const result = session.execute({
			operation: "search",
			query: "read calendar events",
			kinds: ["action"],
			limit: 1,
		});

		expect(result.activated.actions).toEqual(["CALENDAR_READ"]);
		expect(result.activated.contexts).toEqual(["calendar"]);
		expect(result.activated.providers).toEqual(["CALENDAR_STATE"]);
		expect(session.activeActionNames.has("CALENDAR_DELETE")).toBe(false);
		expect(session.toolForAction("CALENDAR_READ")).toBeDefined();
	});

	it("losslessly lists every catalog record and can load the final page's action", () => {
		const actions = Array.from({ length: 137 }, (_, index) =>
			action({
				name: `GLOBAL_TOOL_${String(index).padStart(3, "0")}`,
				description: `Global operation ${index}`,
			}),
		);
		const catalog = buildPlannerCapabilityCatalog({
			actions,
			providers: [
				provider({ name: "GLOBAL_STATE", description: "Global state" }),
			],
			contexts,
		});
		const session = new PlannerCapabilityDiscoverySession({ catalog });
		const visited: string[] = [];
		let cursor: string | undefined;
		let finalPageRef: string | undefined;

		do {
			const page = session.execute({
				operation: "list",
				limit: 13,
				...(cursor ? { cursor } : {}),
			});
			expect(page.catalogHash).toBe(catalog.hash);
			expect(page.matchedCount).toBe(catalog.records.length);
			visited.push(...page.items.map((item) => item.ref));
			finalPageRef = page.items.at(-1)?.ref;
			cursor = page.nextCursor ?? undefined;
			expect(page.hasMore).toBe(Boolean(cursor));
		} while (cursor);

		expect(visited).toEqual(catalog.records.map((record) => record.ref));
		expect(new Set(visited).size).toBe(catalog.records.length);
		const actionRefs = visited.filter((ref) => ref.startsWith("action:"));
		const finalActionRef = actionRefs.at(-1);
		expect(finalPageRef).toBeDefined();
		expect(finalActionRef).toBeDefined();
		const loaded = session.execute({
			operation: "load",
			catalogHash: catalog.hash,
			refs: actionRefs,
		});
		const actionName = (finalActionRef as string).slice("action:".length);
		expect(loaded.activated.actions).toEqual(actions.map((item) => item.name));
		expect(session.activeActionNames).toEqual(
			new Set(actions.map((item) => item.name)),
		);
		expect(session.toolForAction(actionName)?.parameters).toEqual(
			catalog.byRef.get(finalActionRef as string)?.tool?.parameters,
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

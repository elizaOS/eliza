/**
 * Unit tests for the FOLLOW_UPS provider using a deterministic runtime and a
 * pinned clock while exercising the real grouping, entity resolution, label
 * arithmetic, and rendering implementation.
 *
 * Day-label cases deliberately use offsets that are exact multiples of 24h
 * from the pinned clock (plus the exact-now boundary), so assertions record
 * calendar-consistent behavior without freezing the contested sub-day ceil
 * semantics discussed on #26287.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowUpSuggestion } from "../../../services/followUp.ts";
import type { ContactInfo } from "../../../services/relationships.ts";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	State,
	Task,
	UUID,
} from "../../../types/index.ts";
import { followUpsProvider } from "./followUps.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-24T09:00:00.000Z");

const agentId = "22000000-0000-0000-0000-000000000001" as UUID;
const bobId = "22000000-0000-0000-0000-000000000002" as UUID;
const carolId = "22000000-0000-0000-0000-000000000003" as UUID;
const daveId = "22000000-0000-0000-0000-000000000004" as UUID;
const eveId = "22000000-0000-0000-0000-000000000005" as UUID;
const frankId = "22000000-0000-0000-0000-000000000006" as UUID;
const roomId = "22000000-0000-0000-0000-000000000010" as UUID;

const message: Memory = {
	id: "22000000-0000-0000-0000-000000000011" as UUID,
	agentId,
	entityId: agentId,
	roomId,
	content: { text: "Who should I follow up with?" },
};

const state = {} as State;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function contactFor(entityId: UUID): ContactInfo {
	return {
		entityId,
		categories: [],
		tags: [],
		preferences: {},
		customFields: {},
		privacyLevel: "public",
		lastModified: iso(0),
		handles: [],
		interactions: [],
		relationshipStatus: "active",
	};
}

function followUpRow(args: {
	entityId: UUID;
	taskId?: UUID;
	scheduledAtMs?: number;
	reason?: string;
}): { task: Task; contact: ContactInfo } {
	return {
		task: {
			...(args.taskId ? { id: args.taskId } : {}),
			name: "follow_up",
			metadata: {
				status: "pending",
				...(args.scheduledAtMs === undefined
					? {}
					: { scheduledAt: iso(args.scheduledAtMs) }),
				...(args.reason === undefined ? {} : { reason: args.reason }),
			},
		},
		contact: contactFor(args.entityId),
	};
}

function suggestion(partial: {
	entityName: string;
	daysSinceLastContact: number;
}): FollowUpSuggestion {
	return {
		entityId: agentId,
		entityName: partial.entityName,
		reason: "Relationship lapse",
		daysSinceLastContact: partial.daysSinceLastContact,
		relationshipStrength: 0.5,
	};
}

function makeRuntime(args: {
	noService?: boolean;
	upcoming?: Array<{ task: Task; contact: ContactInfo }>;
	suggestions?: FollowUpSuggestion[];
	upcomingError?: unknown;
	entities?: Entity[];
}) {
	const getUpcomingFollowUps = vi.fn(async () => {
		if (args.upcomingError !== undefined) throw args.upcomingError;
		return args.upcoming ?? [];
	});
	const getFollowUpSuggestions = vi.fn(async () => args.suggestions ?? []);
	const warn = vi.fn();
	const reportError = vi.fn();
	const getEntityById = vi.fn(async (id: UUID) =>
		args.entities?.find((e) => e.id === id),
	);
	const runtime = {
		getService: vi.fn((name: string) =>
			name === "follow_up" && !args.noService
				? { getUpcomingFollowUps, getFollowUpSuggestions }
				: null,
		),
		getEntityById,
		logger: { warn },
		reportError,
	} as unknown as IAgentRuntime;

	return {
		runtime,
		getEntityById,
		getUpcomingFollowUps,
		getFollowUpSuggestions,
		warn,
		reportError,
	};
}

function entity(id: UUID, names: string[]): Entity {
	return { id, agentId, names };
}

describe("followUpsProvider", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("exposes the provider contract used by general contexts", () => {
		expect(followUpsProvider).toMatchObject({
			name: "FOLLOW_UPS",
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
		expect(followUpsProvider.description).toEqual(expect.any(String));
	});

	it("stays silent when the FollowUpService is not registered", async () => {
		const { runtime, warn, getFollowUpSuggestions } = makeRuntime({
			noService: true,
		});

		const result = await followUpsProvider.get(runtime, message, state);

		expect(result).toEqual({ text: "", values: {}, data: {} });
		expect(warn).toHaveBeenCalledOnce();
		expect(getFollowUpSuggestions).not.toHaveBeenCalled();
	});

	it("queries the seven-day window including overdue rows and returns the explicit empty state", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { runtime, getUpcomingFollowUps, getFollowUpSuggestions } =
			makeRuntime({ upcoming: [] });

		const result = await followUpsProvider.get(runtime, message, state);

		expect(getUpcomingFollowUps).toHaveBeenCalledOnce();
		expect(getUpcomingFollowUps).toHaveBeenCalledWith(7, true);
		expect(result.text).toBe("No upcoming follow-ups scheduled.");
		expect(result.values).toEqual({ followUpCount: 0 });
		expect(result.data).toEqual({});
		expect(getFollowUpSuggestions).not.toHaveBeenCalled();
	});

	it("groups overdue and upcoming rows, resolves entity names, renders labels and reasons, and reports counts", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { runtime, getEntityById } = makeRuntime({
			upcoming: [
				followUpRow({
					taskId: "22000000-0000-0000-0000-000000000101" as UUID,
					entityId: bobId,
					scheduledAtMs: NOW - 2 * DAY - 12 * HOUR,
					reason: "Reconnect about the project",
				}),
				followUpRow({
					entityId: frankId,
					scheduledAtMs: NOW - 3 * DAY,
				}),
				followUpRow({
					taskId: "22000000-0000-0000-0000-000000000102" as UUID,
					entityId: carolId,
					scheduledAtMs: NOW + DAY,
				}),
				followUpRow({
					taskId: "22000000-0000-0000-0000-000000000103" as UUID,
					entityId: eveId,
					scheduledAtMs: NOW,
				}),
				followUpRow({
					taskId: "22000000-0000-0000-0000-000000000104" as UUID,
					entityId: daveId,
					scheduledAtMs: NOW + 3 * DAY,
					reason: "Share launch notes",
				}),
			],
			entities: [
				entity(bobId, ["Bob"]),
				entity(carolId, ["Carol", "C"]),
				entity(daveId, []),
			],
		});

		const result = await followUpsProvider.get(runtime, message, state);
		const text = result.text ?? "";

		expect(text).toContain("You have 5 follow-ups scheduled:");
		expect(text).toContain("\nOverdue (2):");
		expect(text).toContain(
			"- Bob (2 days overdue) - Reconnect about the project",
		);
		expect(text).toContain("- Unknown\n");
		expect(text).toContain("\nUpcoming (3):");
		expect(text).toContain("- Carol (tomorrow)");
		expect(text).toContain("- Unknown (today)");
		expect(text).toContain("- Unknown (in 3 days) - Share launch notes");

		const indexOf = (fragment: string) => text.indexOf(fragment);
		expect(indexOf("Overdue (2)")).toBeLessThan(indexOf("- Bob"));
		expect(indexOf("- Bob")).toBeLessThan(indexOf("- Unknown\n"));
		expect(indexOf("- Frank")).toBeLessThan(indexOf("Upcoming (3)"));
		expect(indexOf("- Carol (tomorrow)")).toBeLessThan(indexOf("(today)"));
		expect(indexOf("(today)")).toBeLessThan(indexOf("(in 3 days)"));

		expect(getEntityById).toHaveBeenCalledTimes(5);
		for (const id of [bobId, frankId, carolId, eveId, daveId]) {
			expect(getEntityById).toHaveBeenCalledWith(id);
		}

		const counts = {
			followUpCount: 5,
			overdueCount: 2,
			upcomingCount: 3,
			suggestionsCount: 0,
		};
		expect(result.values).toEqual(counts);
		expect(result.data).toEqual(counts);

		expect(text.startsWith("You have 5 follow-ups scheduled:")).toBe(true);
		expect(text.endsWith("- Unknown (in 3 days) - Share launch notes")).toBe(
			true,
		);
	});

	it("uses the singular header for exactly one follow-up", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { runtime } = makeRuntime({
			upcoming: [
				followUpRow({
					taskId: "22000000-0000-0000-0000-000000000105" as UUID,
					entityId: bobId,
					scheduledAtMs: NOW + DAY,
				}),
			],
			entities: [entity(bobId, ["Bob"])],
		});

		const result = await followUpsProvider.get(runtime, message, state);

		expect(result.values?.followUpCount).toBe(1);
		expect(result.text?.startsWith("You have 1 follow-up scheduled:")).toBe(
			true,
		);
		expect(result.text).not.toContain("follow-ups scheduled:");
		expect(result.text).toContain("- Bob (tomorrow)");
	});

	it("appends the suggestions section with per-contact staleness lines", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { runtime, getFollowUpSuggestions } = makeRuntime({
			upcoming: [
				followUpRow({
					taskId: "22000000-0000-0000-0000-000000000106" as UUID,
					entityId: bobId,
					scheduledAtMs: NOW + DAY,
				}),
			],
			entities: [entity(bobId, ["Bob"])],
			suggestions: [
				suggestion({ entityName: "Grace", daysSinceLastContact: 9 }),
				suggestion({ entityName: "Henry", daysSinceLastContact: 21 }),
			],
		});

		const result = await followUpsProvider.get(runtime, message, state);

		expect(getFollowUpSuggestions).toHaveBeenCalledOnce();
		expect(result.text).toContain("\nSuggested follow-ups:");
		expect(result.text).toContain("- Grace (9 days since last contact)");
		expect(result.text).toContain("- Henry (21 days since last contact)");
		expect(result.values?.suggestionsCount).toBe(2);
		expect(result.data?.suggestionsCount).toBe(2);
	});

	it("degrades to an explicit unavailable state and reports when the service query fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const failure = new Error("query failed");
		const { runtime, reportError } = makeRuntime({
			upcomingError: failure,
		});

		const result = await followUpsProvider.get(runtime, message, state);

		expect(result).toEqual({
			text: "Follow-up context is unavailable.",
			values: { followUpsAvailable: false },
			data: { available: false, error: "query failed" },
		});
		expect(reportError).toHaveBeenCalledOnce();
		expect(reportError).toHaveBeenCalledWith("FollowUpsProvider.get", failure, {
			roomId,
		});
	});

	it("stringifies non-Error failures into the unavailable data payload", async () => {
		const { runtime } = makeRuntime({
			upcomingError: "string-failure",
		});

		const result = await followUpsProvider.get(runtime, message, state);

		expect(result.text).toBe("Follow-up context is unavailable.");
		expect(result.data).toEqual({
			available: false,
			error: "string-failure",
		});
	});
});

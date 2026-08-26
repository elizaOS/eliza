import { beforeEach, describe, expect, it, vi } from "vitest";
import { followUpsProvider } from "./followUps.ts";

/**
 * Tests for packages/core/src/features/advanced-capabilities/providers/followUps.ts
 *
 * Materiality: malformed `scheduledAt` metadata (invalid date string) makes
 * `new Date(...).getTime()` return NaN. The provider then classifies the task
 * as *upcoming* (`NaN < now` is false) while the FollowUpService
 * (`getUpcomingFollowUps` in services/followUp.ts) guards with
 * `Number.isFinite` and classifies the same task as *overdue* (NaN -> 0).
 * The mismatch renders "(in NaN days)" into the prompt context.
 */

function makeTask(overrides = {}) {
	const { id = "task-1", metadata = {} } = overrides;
	return {
		id,
		entityId: "entity-1",
		metadata: {
			status: "pending",
			scheduledAt: new Date(Date.now() + 86400000).toISOString(),
			targetEntityId: "contact-1",
			...metadata,
		},
	};
}

function makeFollowUp(task, contact = { entityId: "contact-1" }) {
	return { task, contact };
}

function makeRuntime({
	service = null,
	entities = {},
	reportError = vi.fn(),
} = {}) {
	const warn = vi.fn();
	return {
		getService: vi.fn(() => service),
		logger: { warn },
		getEntityById: vi.fn(async (id) => entities[id] ?? undefined),
		reportError,
	};
}

function makeService({ followUps = [], suggestions = [] } = {}) {
	return {
		getUpcomingFollowUps: vi.fn(async () => followUps),
		getFollowUpSuggestions: vi.fn(async () => suggestions),
	};
}

describe("followUpsProvider", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns empty context and warns when FollowUpService is unavailable", async () => {
		const runtime = makeRuntime({ service: null });
		const result = await followUpsProvider.get(
			runtime,
			{ roomId: "room-1" },
			{},
		);
		expect(result.text).toBe("");
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			"[FollowUpsProvider] FollowUpService not available",
		);
	});

	it("reports a zero-count message when nothing is scheduled", async () => {
		const service = makeService({ followUps: [] });
		const runtime = makeRuntime({ service });
		const result = await followUpsProvider.get(runtime, {}, {});
		expect(result.text).toBe("No upcoming follow-ups scheduled.");
		expect(result.values).toEqual({ followUpCount: 0 });
	});

	it("classifies an overdue task with a day label", async () => {
		const overdueAt = Date.now() - 3 * 86400000;
		const service = makeService({
			followUps: [
				makeFollowUp(
					makeTask({
						id: "task-overdue",
						metadata: {
							scheduledAt: new Date(overdueAt).toISOString(),
						},
					}),
				),
			],
		});
		const runtime = makeRuntime({
			service,
			entities: { "contact-1": { names: ["Alice"] } },
		});
		const result = await followUpsProvider.get(runtime, {}, {});
		expect(result.text).toContain("Overdue (1)");
		expect(result.text).toContain("Alice");
		expect(result.text).toContain("3 days overdue");
		expect(result.values).toEqual({
			followUpCount: 1,
			overdueCount: 1,
			upcomingCount: 0,
			suggestionsCount: 0,
		});
	});

	it("classifies an upcoming task with a days-until label", async () => {
		const upcomingAt = Date.now() + 5 * 86400000;
		const service = makeService({
			followUps: [
				makeFollowUp(
					makeTask({
						id: "task-upcoming",
						metadata: {
							scheduledAt: new Date(upcomingAt).toISOString(),
						},
					}),
				),
			],
		});
		const runtime = makeRuntime({
			service,
			entities: { "contact-1": { names: ["Bob"] } },
		});
		const result = await followUpsProvider.get(runtime, {}, {});
		expect(result.text).toContain("Upcoming (1)");
		expect(result.text).toContain("in 5 days");
		expect(result.text).not.toContain("NaN");
	});

	it("falls back to Unknown when the contact entity cannot be resolved", async () => {
		const service = makeService({
			followUps: [makeFollowUp(makeTask({ id: "task-unknown-contact" }))],
		});
		const runtime = makeRuntime({ service, entities: {} });
		const result = await followUpsProvider.get(runtime, {}, {});
		expect(result.text).toContain("Unknown");
	});

	it("appends suggested follow-ups when present", async () => {
		const service = makeService({
			followUps: [
				makeFollowUp(
					makeTask({
						id: "task-sugg",
						metadata: {
							status: "pending",
							scheduledAt: new Date(Date.now() + 86400000).toISOString(),
							targetEntityId: "contact-1",
						},
					}),
				),
			],
			suggestions: [
				{
					entityId: "contact-2",
					entityName: "Carol",
					reason: "lapsed",
					daysSinceLastContact: 9,
					relationshipStrength: 0.5,
				},
			],
		});
		const runtime = makeRuntime({
			service,
			entities: { "contact-1": { names: ["Alice"] } },
		});
		const result = await followUpsProvider.get(runtime, {}, {});
		expect(result.text).toContain("Suggested follow-ups:");
		expect(result.text).toContain("Carol (9 days since last contact)");
		expect(result.values.suggestionsCount).toBe(1);
	});

	it("returns unavailable context and reports the error when the service throws", async () => {
		const boom = new Error("db down");
		const service = {
			getUpcomingFollowUps: vi.fn(async () => {
				throw boom;
			}),
			getFollowUpSuggestions: vi.fn(),
		};
		const reportError = vi.fn();
		const runtime = makeRuntime({ service, reportError });
		const result = await followUpsProvider.get(
			runtime,
			{ roomId: "room-1" },
			{},
		);
		expect(result.text).toBe("Follow-up context is unavailable.");
		expect(result.values).toEqual({ followUpsAvailable: false });
		expect(reportError).toHaveBeenCalledWith("FollowUpsProvider.get", boom, {
			roomId: "room-1",
		});
	});

	it("treats a malformed scheduledAt like the service does (overdue, no NaN label)", async () => {
		// The FollowUpService guards with Number.isFinite and coerces NaN to 0,
		// classifying such tasks as overdue (0 < now). The provider must mirror
		// that: a malformed date string must NOT render "(in NaN days)".
		const service = makeService({
			followUps: [
				makeFollowUp(
					makeTask({
						id: "task-malformed",
						metadata: {
							scheduledAt: "not-a-valid-date",
						},
					}),
				),
			],
		});
		const runtime = makeRuntime({
			service,
			entities: { "contact-1": { names: ["Alice"] } },
		});
		const result = await followUpsProvider.get(runtime, {}, {});
		expect(result.text).not.toContain("NaN");
		expect(result.text).toContain("Overdue (1)");
		expect(result.values.overdueCount).toBe(1);
		expect(result.values.upcomingCount).toBe(0);
	});
});

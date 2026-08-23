/**
 * Unit tests for the FOLLOW_UPS provider's metadata, scheduling summary,
 * entity-name resolution, suggestion rendering, and unavailable-state paths.
 * The provider runs unchanged against deterministic runtime and service fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowUpService } from "../../../services/followUp.ts";
import type {
	IAgentRuntime,
	Memory,
	ProviderResult,
	UUID,
} from "../../../types/index.ts";
import { followUpsProvider } from "./followUps.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const otherEntityId = "00000000-0000-0000-0000-0000000000cc" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000dd" as UUID;

const message: Memory = {
	entityId,
	agentId,
	roomId,
	content: { text: "What follow-ups do I have?" },
};

function followUp(
	contactEntityId: UUID,
	scheduledAt?: string,
	options: { id?: UUID; reason?: string } = {},
) {
	return {
		task: {
			id: options.id,
			name: "follow_up",
			metadata: { scheduledAt, reason: options.reason },
		},
		contact: { entityId: contactEntityId },
	};
}

function makeRuntime(service: Partial<FollowUpService> | null) {
	const logger = { warn: vi.fn() };
	const runtime = {
		agentId,
		getService: vi.fn(() => service),
		getEntityById: vi.fn(async (id: UUID) =>
			id === entityId ? { id, names: ["Alice"] } : null,
		),
		logger,
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;

	return {
		runtime,
		getService: runtime.getService as ReturnType<typeof vi.fn>,
		getEntityById: runtime.getEntityById as ReturnType<typeof vi.fn>,
		logger,
		reportError: runtime.reportError as ReturnType<typeof vi.fn>,
	};
}

async function getResult(runtime: IAgentRuntime): Promise<ProviderResult> {
	return followUpsProvider.get(runtime, message, {
		values: {},
		data: {},
		text: "",
	});
}

describe("followUpsProvider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exposes the generated provider contract and turn-scoped gates", () => {
		expect(followUpsProvider).toMatchObject({
			name: "FOLLOW_UPS",
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
		expect(followUpsProvider.description).toBeTruthy();
	});

	it("stays silent and warns when the follow-up service is unavailable", async () => {
		const { runtime, logger } = makeRuntime(null);

		await expect(getResult(runtime)).resolves.toEqual({
			text: "",
			values: {},
			data: {},
		});
		expect(logger.warn).toHaveBeenCalledWith(
			"[FollowUpsProvider] FollowUpService not available",
		);
	});

	it("returns the designed empty state without requesting suggestions", async () => {
		const service = {
			getUpcomingFollowUps: vi.fn(async () => []),
			getFollowUpSuggestions: vi.fn(async () => []),
		};
		const { runtime } = makeRuntime(service);

		await expect(getResult(runtime)).resolves.toEqual({
			text: "No upcoming follow-ups scheduled.",
			values: { followUpCount: 0 },
			data: {},
		});
		expect(service.getUpcomingFollowUps).toHaveBeenCalledWith(7, true);
		expect(service.getFollowUpSuggestions).not.toHaveBeenCalled();
	});

	it("groups every item in service order and renders all date-label branches", async () => {
		const now = Date.UTC(2026, 7, 23, 12);
		vi.spyOn(Date, "now").mockReturnValue(now);
		const day = 24 * 60 * 60 * 1000;
		const sharedTime = new Date(now - 3 * day).toISOString();
		const service = {
			getUpcomingFollowUps: vi.fn(async () => [
				followUp(entityId, new Date(now - day).toISOString(), {
					id: "00000000-0000-0000-0000-000000000001" as UUID,
					reason: "Send the proposal",
				}),
				followUp(otherEntityId, sharedTime, {
					id: "00000000-0000-0000-0000-000000000002" as UUID,
				}),
				followUp(entityId, sharedTime, {
					id: "00000000-0000-0000-0000-000000000003" as UUID,
				}),
				followUp(otherEntityId),
				followUp(entityId, new Date(now).toISOString(), {
					id: "00000000-0000-0000-0000-000000000004" as UUID,
				}),
				followUp(otherEntityId, new Date(now + day / 2).toISOString(), {
					id: "00000000-0000-0000-0000-000000000005" as UUID,
				}),
				followUp(entityId, new Date(now + 3 * day).toISOString(), {
					id: "00000000-0000-0000-0000-000000000006" as UUID,
					reason: "Check the launch plan",
				}),
				followUp(otherEntityId, new Date(now + 4 * day).toISOString()),
			]),
			getFollowUpSuggestions: vi.fn(async () => [
				{
					entityName: "Carla",
					daysSinceLastContact: 19,
				},
				{
					entityName: "Dev",
					daysSinceLastContact: 31,
				},
			]),
		};
		const { runtime, getEntityById } = makeRuntime(service);

		const result = await getResult(runtime);

		expect(result.text).toBe(
			[
				"You have 8 follow-ups scheduled:",
				"",
				"Overdue (4):",
				"- Alice (1 day overdue) - Send the proposal",
				"- Unknown (3 days overdue)",
				"- Alice (3 days overdue)",
				"- Unknown",
				"",
				"Upcoming (4):",
				"- Alice (today)",
				"- Unknown (tomorrow)",
				"- Alice (in 3 days) - Check the launch plan",
				"- Unknown",
				"",
				"Suggested follow-ups:",
				"- Carla (19 days since last contact)",
				"- Dev (31 days since last contact)",
			].join("\n"),
		);
		expect(result.values).toEqual({
			followUpCount: 8,
			overdueCount: 4,
			upcomingCount: 4,
			suggestionsCount: 2,
		});
		expect(result.data).toEqual(result.values);
		expect(getEntityById).toHaveBeenCalledTimes(2);
		expect(getEntityById).toHaveBeenNthCalledWith(1, entityId);
		expect(getEntityById).toHaveBeenNthCalledWith(2, otherEntityId);
	});

	it("uses singular summary text and omits empty optional sections", async () => {
		const now = Date.UTC(2026, 7, 23, 12);
		vi.spyOn(Date, "now").mockReturnValue(now);
		const service = {
			getUpcomingFollowUps: vi.fn(async () => [
				followUp(entityId, new Date(now + 2 * 60 * 60 * 1000).toISOString(), {
					id: "00000000-0000-0000-0000-000000000007" as UUID,
				}),
			]),
			getFollowUpSuggestions: vi.fn(async () => []),
		};
		const { runtime } = makeRuntime(service);

		const result = await getResult(runtime);

		expect(result.text).toBe(
			"You have 1 follow-up scheduled:\n\nUpcoming (1):\n- Alice (tomorrow)",
		);
		expect(result.values).toEqual({
			followUpCount: 1,
			overdueCount: 0,
			upcomingCount: 1,
			suggestionsCount: 0,
		});
	});

	it.each([
		[new Error("database offline"), "database offline"],
		["connection lost", "connection lost"],
	])(
		"reports %p and returns an explicit unavailable state",
		async (failure, error) => {
			const service = {
				getUpcomingFollowUps: vi.fn(async () => {
					throw failure;
				}),
			};
			const { runtime, reportError } = makeRuntime(service);

			await expect(getResult(runtime)).resolves.toEqual({
				text: "Follow-up context is unavailable.",
				values: { followUpsAvailable: false },
				data: { available: false, error },
			});
			expect(reportError).toHaveBeenCalledWith(
				"FollowUpsProvider.get",
				failure,
				{ roomId },
			);
		},
	);

	it("translates suggestion failures after rendering scheduled items", async () => {
		const now = Date.UTC(2026, 7, 23, 12);
		vi.spyOn(Date, "now").mockReturnValue(now);
		const failure = new Error("suggestion query failed");
		const service = {
			getUpcomingFollowUps: vi.fn(async () => [
				followUp(entityId, new Date(now).toISOString(), {
					id: "00000000-0000-0000-0000-000000000008" as UUID,
				}),
			]),
			getFollowUpSuggestions: vi.fn(async () => {
				throw failure;
			}),
		};
		const { runtime, reportError } = makeRuntime(service);

		const result = await getResult(runtime);

		expect(result.text).toBe("Follow-up context is unavailable.");
		expect(result.data).toEqual({
			available: false,
			error: "suggestion query failed",
		});
		expect(reportError).toHaveBeenCalledWith("FollowUpsProvider.get", failure, {
			roomId,
		});
	});
});

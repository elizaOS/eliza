import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followUpsProvider } from "../advanced-capabilities/providers/followUps.ts";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../runtime.ts";
import type { FollowUpService } from "../services/followUp.ts";
import type { RelationshipsService } from "../services/relationships.ts";
import type { TaskService } from "../services/task.ts";
import type { Memory, State } from "../types/index.ts";
import { asUUID } from "../types/index.ts";
import { stringToUuid } from "../utils.ts";

const agentId = asUUID("92000000-0000-0000-0000-000000000001");
const senderId = asUUID("92000000-0000-0000-0000-000000000002");
const roomId = asUUID("92000000-0000-0000-0000-000000000003");
const adaId = asUUID("92000000-0000-0000-0000-000000000010");
const miraId = asUUID("92000000-0000-0000-0000-000000000011");
const solId = asUUID("92000000-0000-0000-0000-000000000012");
const ivyId = asUUID("92000000-0000-0000-0000-000000000013");
const now = new Date("2026-04-09T12:00:00.000Z");
const relationshipsRoomId = stringToUuid(`relationships-${agentId}`);

const runtimes: AgentRuntime[] = [];

function createRuntime(adapter: InMemoryDatabaseAdapter): AgentRuntime {
	return new AgentRuntime({
		agentId,
		character: {
			id: agentId,
			name: "Follow Up Runtime Test Agent",
			username: "follow-up-runtime-test-agent",
			clients: [],
			settings: {},
		},
		adapter,
		enableKnowledge: false,
		enableTrajectories: false,
	});
}

function createMessage(id: string, text: string): Memory {
	return {
		id: asUUID(id),
		entityId: senderId,
		roomId,
		content: {
			text,
		},
	};
}

function createState(): State {
	return {
		values: {},
		data: {},
		text: "",
	};
}

async function createInitializedRuntime(): Promise<AgentRuntime> {
	const runtime = createRuntime(new InMemoryDatabaseAdapter());
	runtimes.push(runtime);
	await runtime.initialize({
		allowNoDatabase: true,
		skipMigrations: true,
	});
	await runtime.getServiceLoadPromise("relationships");
	await runtime.getServiceLoadPromise("follow_up");
	await runtime.getServiceLoadPromise("task");
	return runtime;
}

async function seedContact(
	runtime: AgentRuntime,
	entityId: typeof adaId,
	name: string,
	categories: string[] = ["friend"],
): Promise<void> {
	await runtime.createEntity({
		id: entityId,
		names: [name],
	});
	const relationshipsService = runtime.getService(
		"relationships",
	) as RelationshipsService;
	await relationshipsService.addContact(entityId, categories, undefined, {
		displayName: name,
	});
}

function requireTaskId(task: { id?: string }): string {
	expect(task.id).toBeDefined();
	return task.id as string;
}

describe("follow-up runtime integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(async () => {
		await Promise.all(
			runtimes.splice(0).map(async (runtime) => {
				await runtime.stop();
			}),
		);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("schedules, lists, and completes follow-ups with real runtime state", async () => {
		const runtime = await createInitializedRuntime();
		await seedContact(runtime, adaId, "Ada");

		const followUpService = runtime.getService("follow_up") as FollowUpService;
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		const scheduledAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);

		const task = await followUpService.scheduleFollowUp(
			adaId,
			scheduledAt,
			"Check in",
			"high",
			"Ask how the project is going",
		);
		const taskId = requireTaskId(task);

		const storedTask = await runtime.getTask(taskId);
		const scheduledContact = await relationshipsService.getContact(adaId);
		const upcoming = await followUpService.getUpcomingFollowUps(1, false);

		expect(storedTask).toMatchObject({
			id: task.id,
			dueAt: scheduledAt.getTime(),
			metadata: expect.objectContaining({
				targetEntityId: adaId,
				reason: "Check in",
				priority: "high",
				message: "Ask how the project is going",
				status: "pending",
				scheduledAt: scheduledAt.toISOString(),
			}),
		});
		expect(scheduledContact?.customFields).toMatchObject({
			displayName: "Ada",
			nextFollowUpAt: scheduledAt.toISOString(),
			nextFollowUpReason: "Check in",
		});
		expect(upcoming).toHaveLength(1);
		expect(upcoming[0]).toMatchObject({
			task: expect.objectContaining({ id: task.id }),
			contact: expect.objectContaining({ entityId: adaId }),
		});

		await followUpService.completeFollowUp(taskId, "Reached out already");

		const completedTask = await runtime.getTask(taskId);
		const completedContact = await relationshipsService.getContact(adaId);
		const remainingUpcoming = await followUpService.getUpcomingFollowUps(
			1,
			true,
		);

		expect(completedTask?.metadata).toMatchObject({
			status: "completed",
			completionNotes: "Reached out already",
		});
		expect(completedContact?.customFields.displayName).toBe("Ada");
		expect(completedContact?.customFields.nextFollowUpAt).toBeUndefined();
		expect(completedContact?.customFields.nextFollowUpReason).toBeUndefined();
		expect(remainingUpcoming).toHaveLength(0);
	});

	it("snoozes follow-ups by moving dueAt and only fires when the new time arrives", async () => {
		const runtime = await createInitializedRuntime();
		await seedContact(runtime, miraId, "Mira");

		const followUpService = runtime.getService("follow_up") as FollowUpService;
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		const taskService = runtime.getService("task") as TaskService;
		const emitEventSpy = vi.spyOn(runtime, "emitEvent");
		const originalTime = new Date(now.getTime() + 5 * 60 * 1000);
		const snoozedTime = new Date(now.getTime() + 60 * 60 * 1000);

		const task = await followUpService.scheduleFollowUp(
			miraId,
			originalTime,
			"Send the follow-up",
			"medium",
			"Ping Mira about lunch",
		);
		const taskId = requireTaskId(task);

		await followUpService.snoozeFollowUp(taskId, snoozedTime);

		const snoozedTask = await runtime.getTask(taskId);
		const snoozedContact = await relationshipsService.getContact(miraId);

		expect(snoozedTask).toMatchObject({
			id: task.id,
			dueAt: snoozedTime.getTime(),
			metadata: expect.objectContaining({
				scheduledAt: snoozedTime.toISOString(),
				originalScheduledAt: originalTime.toISOString(),
			}),
		});
		expect(snoozedContact?.customFields.nextFollowUpAt).toBe(
			snoozedTime.toISOString(),
		);

		vi.setSystemTime(new Date(now.getTime() + 10 * 60 * 1000));
		await taskService.runDueTasks();

		expect(
			await runtime.getMemories({
				roomId: relationshipsRoomId,
				tableName: "reminders",
				count: 10,
			}),
		).toHaveLength(0);
		expect(await runtime.getTask(taskId)).not.toBeNull();

		vi.setSystemTime(new Date(now.getTime() + 61 * 60 * 1000));
		await taskService.runDueTasks();

		const reminders = await runtime.getMemories({
			roomId: relationshipsRoomId,
			tableName: "reminders",
			count: 10,
		});

		expect(await runtime.getTask(taskId)).toBeNull();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toMatchObject({
			content: expect.objectContaining({
				type: "follow_up_reminder",
				text: expect.stringContaining("Mira"),
			}),
			metadata: expect.objectContaining({
				targetEntityId: miraId,
				priority: "medium",
				taskId: task.id,
			}),
		});
		expect(emitEventSpy).toHaveBeenCalledWith("follow_up:due", {
			taskId: task.id,
			taskName: "follow_up",
			entityId: miraId,
			message: "Ping Mira about lunch",
		});
	});

	it("summarizes overdue and upcoming follow-ups in the provider output", async () => {
		const runtime = await createInitializedRuntime();
		await seedContact(runtime, solId, "Sol");
		await seedContact(runtime, ivyId, "Ivy");

		const followUpService = runtime.getService("follow_up") as FollowUpService;
		vi.spyOn(followUpService, "getFollowUpSuggestions").mockResolvedValue([]);

		await followUpService.scheduleFollowUp(
			solId,
			new Date(now.getTime() - 60 * 60 * 1000),
			"Reply about dinner",
			"high",
		);
		await followUpService.scheduleFollowUp(
			ivyId,
			new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
			"Check in about travel",
			"medium",
		);

		const providerResult = await followUpsProvider.get(
			runtime,
			createMessage("92000000-0000-0000-0000-000000000100", "show follow ups"),
			createState(),
		);

		expect(providerResult.text).toContain("You have 2 follow-ups scheduled:");
		expect(providerResult.text).toContain("Overdue (1):");
		expect(providerResult.text).toContain("Sol");
		expect(providerResult.text).toContain("Reply about dinner");
		expect(providerResult.text).toContain("Upcoming (1):");
		expect(providerResult.text).toContain("Ivy");
		expect(providerResult.text).toContain("Check in about travel");
		expect(providerResult.values).toMatchObject({
			followUpCount: 2,
			overdueCount: 1,
			upcomingCount: 1,
			suggestionsCount: 0,
		});
	});
});

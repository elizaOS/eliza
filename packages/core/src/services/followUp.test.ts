/**
 * Unit coverage for the FollowUpService API surface: scheduleFollowUp task
 * shape and contact mirroring, getUpcomingFollowUps window filtering and
 * ordering, completeFollowUp atomic fallbacks, snoozeFollowUp bookkeeping,
 * suggestion generation and scoring, and the follow_up worker gates. The
 * teardown/parking lifecycle races are covered separately in follow-up.test.ts;
 * this suite drives the real service directly against deterministic in-memory
 * collaborator doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryType } from "../types/memory";
import type { JsonValue, UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task, TaskWorker } from "../types/task";
import { FollowUpService } from "./followUp.ts";
import type { ContactInfo } from "./relationships.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const CONTACT_A = "00000000-0000-0000-0000-0000000000aa" as UUID;
const CONTACT_B = "00000000-0000-0000-0000-0000000000bb" as UUID;
const CONTACT_C = "00000000-0000-0000-0000-0000000000cc" as UUID;
const CONTACT_D = "00000000-0000-0000-0000-0000000000dd" as UUID;
const MISSING_ID = "00000000-0000-0000-0000-00000000dead" as UUID;
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function makeContact(
	id: UUID,
	fields: {
		categories?: string[];
		customFields?: Record<string, JsonValue>;
		names?: string[];
	} = {},
): ContactInfo {
	return {
		entityId: id,
		names: fields.names ?? ["Alice"],
		categories: fields.categories ?? [],
		tags: [],
		preferences: {} as ContactInfo["preferences"],
		customFields: { ...(fields.customFields ?? {}) },
		privacyLevel: "private",
		lastModified: iso(0),
		handles: [] as ContactInfo["handles"],
		interactions: [] as ContactInfo["interactions"],
		relationshipStatus: "active" as ContactInfo["relationshipStatus"],
	};
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id: id as UUID,
		name: "follow_up",
		description: "Seeded follow-up task",
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		tags: ["follow-up", "queue"],
		dueAt: T0 + DAY,
		metadata: {
			targetEntityId: CONTACT_A,
			reason: "routine check-in",
			priority: "medium",
			status: "pending",
			scheduledAt: iso(DAY),
			createdAt: iso(0),
		},
		...overrides,
	};
}

function makeHarness() {
	const tasks = new Map<string, Task>();
	const workers = new Map<string, TaskWorker>();
	const memories: Array<{ memory: unknown; table?: string }> = [];
	const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const entities = new Map<UUID, { id: UUID; names: string[] }>();
	const contacts = new Map<UUID, ContactInfo>();
	const insights: Array<{ entity: { id: UUID }; daysSinceContact: number }> =
		[];
	const analytics = new Map<UUID, { strength: number }>();
	// Forces the storage adapter's atomic pending-task transition to refuse,
	// mimicking a concurrent claim winning the race before completeFollowUp.
	const refusedTransitions = new Set<string>();

	function addEntity(id: UUID, names: string[]): void {
		entities.set(id, { id, names });
	}

	function addContact(
		id: UUID,
		fields?: {
			categories?: string[];
			customFields?: Record<string, JsonValue>;
			names?: string[];
		},
	): ContactInfo {
		const contact = makeContact(id, fields);
		contacts.set(id, contact);
		return contact;
	}

	function seedTask(task: Task): Task {
		tasks.set(task.id as string, task);
		return task;
	}

	const relationshipsService = {
		getContact: async (id: UUID) => contacts.get(id) ?? null,
		updateContact: async (
			id: UUID,
			patch: { customFields: Record<string, JsonValue> },
		) => {
			const existing = contacts.get(id);
			if (!existing) throw new Error(`no contact ${id}`);
			contacts.set(id, { ...existing, customFields: patch.customFields });
		},
		searchContacts: async () => Array.from(contacts.values()),
		getRelationshipInsights: async () => ({ needsAttention: insights }),
		analyzeRelationship: async (_agentId: UUID, id: UUID) =>
			analytics.get(id) ?? null,
	};

	const runtime = {
		agentId: AGENT_ID,
		registerTaskWorker: (worker: TaskWorker) => {
			workers.set(worker.name, worker);
		},
		getTaskWorker: (name: string) => workers.get(name),
		unregisterTaskWorker: (name: string) => {
			workers.delete(name);
		},
		getServiceLoadPromise: async () => relationshipsService,
		getEntityById: async (id: UUID) => entities.get(id) ?? null,
		createMemory: async (memory: unknown, table?: string) => {
			memories.push({ memory, table });
		},
		emitEvent: async (event: string, payload: Record<string, unknown>) => {
			events.push({ event, payload });
		},
		// Honors the real adapters' requested-tags contract: only rows carrying
		// EVERY requested tag are polled by the scheduler.
		getTasks: async (params: { tags?: string[] }) =>
			Array.from(tasks.values()).filter((task) =>
				(params.tags ?? []).every((tag) => task.tags?.includes(tag)),
			),
		getTask: async (id: UUID) => tasks.get(id) ?? null,
		createTask: async (task: Task) => {
			const id = (task.id ?? `task-${tasks.size + 1}`) as UUID;
			tasks.set(id, { ...task, id });
			return id;
		},
		updateTask: async (id: UUID, patch: Partial<Task>) => {
			const existing = tasks.get(id);
			if (!existing) throw new Error(`no task ${id}`);
			tasks.set(id, { ...existing, ...patch });
		},
		updatePendingTask: async (id: UUID, patch: Partial<Task>) => {
			const existing = tasks.get(id);
			if (!existing) return false;
			if (refusedTransitions.has(id)) return false;
			if (!existing.tags?.includes("queue")) return false;
			if (
				existing.metadata?.status != null &&
				existing.metadata.status !== "pending"
			) {
				return false;
			}
			tasks.set(id, { ...existing, ...patch });
			return true;
		},
		deleteTask: async (id: UUID) => {
			tasks.delete(id);
		},
	} as unknown as IAgentRuntime;

	return {
		runtime,
		tasks,
		workers,
		memories,
		events,
		entities,
		contacts,
		insights,
		analytics,
		refusedTransitions,
		addEntity,
		addContact,
		seedTask,
	};
}

type Harness = ReturnType<typeof makeHarness>;

async function startService(harness: Harness): Promise<FollowUpService> {
	return (await FollowUpService.start(harness.runtime)) as FollowUpService;
}

/** Seeds one qualifying suggestion candidate end-to-end. */
function qualifyCandidate(
	harness: Harness,
	id: UUID,
	fields: {
		days: number;
		strength?: number;
		categories?: string[];
		names?: string[];
		withEntity?: boolean;
		withAnalytics?: boolean;
	},
): void {
	harness.addContact(id, { categories: fields.categories ?? [] });
	if (fields.withEntity !== false) {
		harness.addEntity(id, fields.names ?? ["Alice"]);
	}
	harness.insights.push({
		entity: { id },
		daysSinceContact: fields.days,
	});
	if (fields.withAnalytics !== false && fields.strength != null) {
		harness.analytics.set(id, { strength: fields.strength });
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("FollowUpService identity and startup", () => {
	it("exposes the follow_up service type and capability description", () => {
		expect(FollowUpService.serviceType).toBe("follow_up");
		const service = new FollowUpService();
		expect(service.capabilityDescription).toBe(
			"Task-based follow-up scheduling and management for contacts",
		);
	});

	it("start() registers exactly one follow_up task worker", async () => {
		const harness = makeHarness();
		await startService(harness);
		const worker = harness.workers.get("follow_up");
		expect(worker).toBeDefined();
		expect(worker?.name).toBe("follow_up");
	});
});

describe("scheduleFollowUp", () => {
	it("throws when the contact does not exist and creates nothing", async () => {
		const harness = makeHarness();
		const service = await startService(harness);
		await expect(
			service.scheduleFollowUp(MISSING_ID, new Date(T0 + DAY), "check in"),
		).rejects.toThrow(`Contact ${MISSING_ID} not found`);
		expect(harness.tasks.size).toBe(0);
	});

	it("creates a queued one-shot task and mirrors the follow-up onto the contact", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A, {
			customFields: { favoriteColor: "orange" },
		});
		const service = await startService(harness);
		const at = new Date(T0 + 3 * DAY);
		const task = await service.scheduleFollowUp(
			CONTACT_A,
			at,
			"Birthday check-in",
			"high",
			"Bring cake",
		);

		expect(task.name).toBe("follow_up");
		expect(task.description).toBe("Follow-up with contact: Birthday check-in");
		expect(task.entityId).toBe(AGENT_ID);
		expect(task.agentId).toBe(AGENT_ID);
		expect(task.tags).toEqual(["follow-up", "high", "relationships", "queue"]);
		expect(task.dueAt).toBe(at.getTime());
		expect(task.metadata?.targetEntityId).toBe(CONTACT_A);
		expect(task.metadata?.reason).toBe("Birthday check-in");
		expect(task.metadata?.priority).toBe("high");
		expect(task.metadata?.message).toBe("Bring cake");
		expect(task.metadata?.status).toBe("pending");
		expect(task.metadata?.scheduledAt).toBe(at.toISOString());
		expect(typeof task.metadata?.createdAt).toBe("string");

		const stored = harness.tasks.get(task.id as string);
		expect(stored).toBeDefined();

		const contact = harness.contacts.get(CONTACT_A);
		expect(contact?.customFields.nextFollowUpAt).toBe(at.toISOString());
		expect(contact?.customFields.nextFollowUpReason).toBe("Birthday check-in");
		expect(contact?.customFields.favoriteColor).toBe("orange");
	});

	it("defaults the priority to medium", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		const service = await startService(harness);
		const task = await service.scheduleFollowUp(
			CONTACT_A,
			new Date(T0 + DAY),
			"say hi",
		);
		expect(task.metadata?.priority).toBe("medium");
	});
});

describe("scheduleMultipleFollowUps", () => {
	it("persists every entry in input order with default priorities filled", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addContact(CONTACT_B);
		const service = await startService(harness);

		const created = await service.scheduleMultipleFollowUps([
			{
				entityId: CONTACT_A,
				scheduledAt: new Date(T0 + DAY),
				reason: "first",
				priority: "low",
			},
			{
				entityId: CONTACT_B,
				scheduledAt: new Date(T0 + 2 * DAY),
				reason: "second",
			},
		]);

		expect(created).toHaveLength(2);
		expect(created[0]?.metadata?.reason).toBe("first");
		expect(created[0]?.metadata?.priority).toBe("low");
		expect(created[1]?.metadata?.reason).toBe("second");
		expect(created[1]?.metadata?.priority).toBe("medium");
		expect(new Set(created.map((task) => task.id)).size).toBe(2);
	});
});

describe("getUpcomingFollowUps", () => {
	function seedQueuedRow(
		harness: Harness,
		id: string,
		targetId: UUID,
		offsetMs: number | null,
		extra?: Partial<Task>,
	): Task {
		return harness.seedTask(
			makeTask(id, {
				metadata: {
					targetEntityId: targetId,
					reason: `row ${id}`,
					priority: "medium",
					status: "pending",
					...(offsetMs == null ? {} : { scheduledAt: iso(offsetMs) }),
					createdAt: iso(0),
				},
				...extra,
			}),
		);
	}

	it("returns an empty list when nothing is scheduled", async () => {
		const harness = makeHarness();
		const service = await startService(harness);
		expect(await service.getUpcomingFollowUps()).toEqual([]);
	});

	it("orders matching rows by scheduled time and keeps tied timestamps in insertion order", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addContact(CONTACT_B);
		harness.addContact(CONTACT_C);
		seedQueuedRow(harness, "late", CONTACT_A, 3 * DAY);
		seedQueuedRow(harness, "tie-first", CONTACT_B, DAY);
		seedQueuedRow(harness, "overdue", CONTACT_C, -2 * DAY);
		seedQueuedRow(harness, "tie-second", CONTACT_B, DAY);
		const service = await startService(harness);

		const upcoming = await service.getUpcomingFollowUps();
		expect(upcoming.map((row) => row.task.id)).toEqual([
			"overdue",
			"tie-first",
			"tie-second",
			"late",
		]);
		for (const row of upcoming) {
			expect(row.contact.entityId).toBeDefined();
		}
	});

	it("drops overdue rows when includeOverdue is false", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addContact(CONTACT_B);
		seedQueuedRow(harness, "overdue", CONTACT_A, -DAY);
		seedQueuedRow(harness, "soon", CONTACT_B, DAY);
		const service = await startService(harness);

		const upcoming = await service.getUpcomingFollowUps(7, false);
		expect(upcoming.map((row) => row.task.id)).toEqual(["soon"]);
	});

	it("applies the requested day horizon inclusively at both edges", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		seedQueuedRow(harness, "now", CONTACT_A, 0);
		seedQueuedRow(harness, "edge", CONTACT_A, 7 * DAY);
		seedQueuedRow(harness, "beyond", CONTACT_A, 7 * DAY + 1);
		const service = await startService(harness);

		const upcoming = await service.getUpcomingFollowUps(7, false);
		expect(upcoming.map((row) => row.task.id)).toEqual(["now", "edge"]);
	});

	it("ignores rows whose metadata status is not pending", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		seedQueuedRow(harness, "done", CONTACT_A, DAY, {
			metadata: {
				targetEntityId: CONTACT_A,
				reason: "done",
				priority: "medium",
				status: "completed",
				scheduledAt: iso(DAY),
				createdAt: iso(0),
			},
		});
		seedQueuedRow(harness, "running", CONTACT_A, DAY, {
			metadata: {
				targetEntityId: CONTACT_A,
				reason: "running",
				priority: "medium",
				status: "executing",
				scheduledAt: iso(DAY),
				createdAt: iso(0),
			},
		});
		seedQueuedRow(harness, "nostatus", CONTACT_A, DAY, {
			metadata: {
				targetEntityId: CONTACT_A,
				reason: "nostatus",
				priority: "medium",
				scheduledAt: iso(DAY),
				createdAt: iso(0),
			},
		});
		seedQueuedRow(harness, "live", CONTACT_A, DAY);
		const service = await startService(harness);

		const upcoming = await service.getUpcomingFollowUps();
		expect(upcoming.map((row) => row.task.id)).toEqual(["live"]);
	});

	it("skips rows whose target contact no longer exists", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		seedQueuedRow(harness, "ghosted", MISSING_ID, DAY);
		seedQueuedRow(harness, "known", CONTACT_A, DAY);
		const service = await startService(harness);

		const upcoming = await service.getUpcomingFollowUps();
		expect(upcoming.map((row) => row.task.id)).toEqual(["known"]);
	});

	it("treats missing or unparseable scheduledAt as epoch-zero overdue rows", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addContact(CONTACT_B);
		seedQueuedRow(harness, "garbage-date", CONTACT_A, null, {
			metadata: {
				targetEntityId: CONTACT_A,
				reason: "garbage",
				priority: "medium",
				status: "pending",
				scheduledAt: "not-a-date",
				createdAt: iso(0),
			},
		});
		seedQueuedRow(harness, "no-date", CONTACT_B, null);
		seedQueuedRow(harness, "normal-overdue", CONTACT_A, -2 * DAY);
		const service = await startService(harness);

		const includingOverdue = await service.getUpcomingFollowUps();
		expect(includingOverdue.map((row) => row.task.id)).toEqual([
			"garbage-date",
			"no-date",
			"normal-overdue",
		]);

		const excludingOverdue = await service.getUpcomingFollowUps(7, false);
		expect(excludingOverdue).toEqual([]);
	});
});

describe("completeFollowUp", () => {
	it("rejects an unknown task id", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		const service = await startService(harness);
		await expect(service.completeFollowUp(MISSING_ID)).rejects.toThrow(
			`Task ${MISSING_ID} not found`,
		);
	});

	it("propagates storage failures", async () => {
		const harness = makeHarness();
		harness.runtime.getTask = async () => {
			throw new Error("boom");
		};
		const service = await startService(harness);
		await expect(service.completeFollowUp("t1" as UUID)).rejects.toThrow(
			"boom",
		);
	});

	it("completes atomically, unqueues the row, records notes, and clears the contact mirror", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A, {
			customFields: {
				nextFollowUpAt: iso(DAY),
				nextFollowUpReason: "routine check-in",
				favoriteColor: "orange",
			},
		});
		harness.seedTask(makeTask("t1"));
		const service = await startService(harness);

		await service.completeFollowUp("t1" as UUID, "wished her well");

		const stored = harness.tasks.get("t1");
		expect(stored?.tags).toEqual(["follow-up"]);
		expect(stored?.metadata?.status).toBe("completed");
		expect(stored?.metadata?.completionNotes).toBe("wished her well");
		expect(stored?.metadata?.completedAt).toEqual(expect.any(String));
		expect(stored?.metadata?.scheduledAt).toBe(iso(DAY));

		const contact = harness.contacts.get(CONTACT_A);
		expect(contact?.customFields.nextFollowUpAt).toBeUndefined();
		expect(contact?.customFields.nextFollowUpReason).toBeUndefined();
		expect(contact?.customFields.favoriteColor).toBe("orange");
	});

	it("unqueues through the fallback path when the row was completed concurrently", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A, {
			customFields: { nextFollowUpAt: iso(DAY) },
		});
		const finishedAt = iso(-DAY);
		harness.seedTask(
			makeTask("t1", {
				tags: ["follow-up", "queue"],
				metadata: {
					targetEntityId: CONTACT_A,
					reason: "routine check-in",
					priority: "medium",
					status: "completed",
					completedAt: finishedAt,
					scheduledAt: iso(DAY),
					createdAt: iso(0),
				},
			}),
		);
		const service = await startService(harness);

		await service.completeFollowUp("t1" as UUID);

		const stored = harness.tasks.get("t1");
		expect(stored?.tags).toEqual(["follow-up"]);
		expect(stored?.metadata?.status).toBe("completed");
		expect(stored?.metadata?.completedAt).toBe(finishedAt);
		expect(
			harness.contacts.get(CONTACT_A)?.customFields.nextFollowUpAt,
		).toBeUndefined();
	});

	it("fails closed when the atomic transition is refused while the row is still pending", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.seedTask(makeTask("t1"));
		harness.refusedTransitions.add("t1");
		const service = await startService(harness);

		await expect(service.completeFollowUp("t1" as UUID)).rejects.toThrow(
			`Task t1 could not be completed atomically`,
		);
		expect(harness.tasks.get("t1")?.metadata?.status).toBe("pending");
		expect(harness.tasks.get("t1")?.tags).toContain("queue");
	});

	it("reports rows that are currently executing", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.seedTask(
			makeTask("t1", {
				metadata: {
					targetEntityId: CONTACT_A,
					reason: "routine check-in",
					priority: "medium",
					status: "executing",
					scheduledAt: iso(DAY),
					createdAt: iso(0),
				},
			}),
		);
		const service = await startService(harness);

		await expect(service.completeFollowUp("t1" as UUID)).rejects.toThrow(
			`Task t1 is already executing`,
		);
	});
});

describe("snoozeFollowUp", () => {
	it("shifts the deadline and records snooze bookkeeping on the task and contact", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A, {
			customFields: { nextFollowUpReason: "routine check-in" },
		});
		harness.seedTask(makeTask("t1"));
		const service = await startService(harness);
		const snoozedTo = new Date(T0 + 9 * DAY);

		await service.snoozeFollowUp("t1" as UUID, snoozedTo);

		const stored = harness.tasks.get("t1");
		expect(stored?.dueAt).toBe(snoozedTo.getTime());
		expect(stored?.metadata?.scheduledAt).toBe(snoozedTo.toISOString());
		expect(stored?.metadata?.originalScheduledAt).toBe(iso(DAY));
		expect(stored?.metadata?.snoozedAt).toEqual(expect.any(String));
		const contact = harness.contacts.get(CONTACT_A);
		expect(contact?.customFields.nextFollowUpAt).toBe(snoozedTo.toISOString());
		expect(contact?.customFields.nextFollowUpReason).toBe("routine check-in");
	});

	it("falls back to createdAt when the row never had a scheduledAt", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.seedTask(
			makeTask("t1", {
				metadata: {
					targetEntityId: CONTACT_A,
					reason: "routine check-in",
					priority: "medium",
					status: "pending",
					createdAt: iso(0),
				},
			}),
		);
		const service = await startService(harness);

		await service.snoozeFollowUp("t1" as UUID, new Date(T0 + DAY));

		expect(harness.tasks.get("t1")?.metadata?.originalScheduledAt).toBe(iso(0));
	});

	it("rejects an unknown task id", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		const service = await startService(harness);
		await expect(
			service.snoozeFollowUp(MISSING_ID, new Date(T0 + DAY)),
		).rejects.toThrow(`Task ${MISSING_ID} not found`);
	});
});

describe("getFollowUpSuggestions", () => {
	it("suggests only contacts needing attention beyond fourteen days", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, { days: 16, strength: 40 });
		qualifyCandidate(harness, CONTACT_B, { days: 10, strength: 90 });
		qualifyCandidate(harness, CONTACT_C, { days: 14, strength: 90 });
		const service = await startService(harness);

		const suggestions = await service.getFollowUpSuggestions();
		expect(suggestions.map((suggestion) => suggestion.entityId)).toEqual([
			CONTACT_A,
		]);
	});

	it("skips candidates whose entity record is gone", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, {
			days: 20,
			strength: 40,
			withEntity: false,
		});
		const service = await startService(harness);

		expect(await service.getFollowUpSuggestions()).toEqual([]);
	});

	it("skips candidates without relationship analytics", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, {
			days: 20,
			withAnalytics: false,
		});
		const service = await startService(harness);

		expect(await service.getFollowUpSuggestions()).toEqual([]);
	});

	it("labels candidates without names as Unknown", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, {
			days: 18,
			strength: 45,
			names: [],
		});
		const service = await startService(harness);

		const [suggestion] = await service.getFollowUpSuggestions();
		expect(suggestion?.entityName).toBe("Unknown");
		expect(suggestion?.reason).toBe("No contact for 18 days");
		expect(suggestion?.relationshipStrength).toBe(45);
	});

	it("generates category-specific reasons and messages", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, {
			days: 31,
			strength: 50,
			categories: ["family"],
			names: ["Mom"],
		});
		qualifyCandidate(harness, CONTACT_B, {
			days: 15,
			strength: 80,
			categories: ["friend"],
			names: ["Sam"],
		});
		qualifyCandidate(harness, CONTACT_C, {
			days: 61,
			strength: 10,
			categories: ["colleague"],
			names: ["Rae"],
		});
		qualifyCandidate(harness, CONTACT_D, {
			days: 15,
			strength: 5,
			categories: ["vip"],
			names: ["Pat"],
		});
		const service = await startService(harness);

		const suggestions = await service.getFollowUpSuggestions();
		const byEntity = new Map(
			suggestions.map((suggestion) => [suggestion.entityId, suggestion]),
		);
		expect(byEntity.get(CONTACT_A)?.reason).toBe(
			"It's been over a month since you checked in with family",
		);
		expect(byEntity.get(CONTACT_A)?.suggestedMessage).toBe(
			"Hey Mom, thinking of you! How have you been?",
		);
		expect(byEntity.get(CONTACT_B)?.reason).toBe(
			"Maintain this strong friendship with regular contact",
		);
		expect(byEntity.get(CONTACT_B)?.suggestedMessage).toBe(
			"Hi Sam! It's been a while - would love to catch up!",
		);
		expect(byEntity.get(CONTACT_C)?.reason).toBe(
			"Professional relationships benefit from periodic check-ins",
		);
		expect(byEntity.get(CONTACT_C)?.suggestedMessage).toBe(
			"Hi Rae, hope you're doing well. Any updates on your projects?",
		);

		expect(byEntity.get(CONTACT_D)?.reason).toBe(
			"VIP contact - priority follow-up recommended",
		);
		expect(byEntity.get(CONTACT_D)?.suggestedMessage).toBe(
			"Hi Pat, just wanted to check in and see how you're doing!",
		);
	});

	it("plain candidates get the default reason and message", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, {
			days: 20,
			strength: 40,
			names: ["Robin"],
		});
		const service = await startService(harness);

		const [suggestion] = await service.getFollowUpSuggestions();
		expect(suggestion?.reason).toBe("No contact for 20 days");
		expect(suggestion?.suggestedMessage).toBe(
			"Hi Robin, just wanted to check in and see how you're doing!",
		);
	});

	it("ranks suggestions by strength-weighted staleness, highest first", async () => {
		const harness = makeHarness();
		qualifyCandidate(harness, CONTACT_A, { days: 40, strength: 80 });
		qualifyCandidate(harness, CONTACT_B, { days: 20, strength: 100 });
		qualifyCandidate(harness, CONTACT_C, { days: 50, strength: 10 });
		const service = await startService(harness);

		const suggestions = await service.getFollowUpSuggestions();
		expect(suggestions.map((suggestion) => suggestion.entityId)).toEqual([
			CONTACT_A,
			CONTACT_B,
			CONTACT_C,
		]);
	});
});

describe("follow_up worker gates and execution", () => {
	async function startedWorker(harness: Harness): Promise<TaskWorker> {
		await startService(harness);
		const worker = harness.workers.get("follow_up");
		expect(worker).toBeDefined();
		return worker as TaskWorker;
	}

	function runnableTask(): Task {
		return makeTask("wx1", {
			tags: ["follow-up", "queue"],
			metadata: {
				targetEntityId: CONTACT_A,
				reason: "Birthday",
				message: "Call mom back",
				priority: "high",
				status: "pending",
				scheduledAt: iso(0),
				createdAt: iso(0),
			},
		});
	}

	it("runs pending rows whose target entity resolves", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addEntity(CONTACT_A, ["Alice"]);
		const worker = await startedWorker(harness);
		await expect(
			worker.shouldRun?.(harness.runtime, runnableTask()),
		).resolves.toBe(true);
	});

	it("refuses completed rows", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addEntity(CONTACT_A, ["Alice"]);
		const worker = await startedWorker(harness);
		const task = runnableTask();
		task.metadata.status = "completed";
		await expect(worker.shouldRun?.(harness.runtime, task)).resolves.toBe(
			false,
		);
	});

	it("refuses rows without a target entity id", async () => {
		const harness = makeHarness();
		const worker = await startedWorker(harness);
		const task = runnableTask();
		delete task.metadata.targetEntityId;
		await expect(worker.shouldRun?.(harness.runtime, task)).resolves.toBe(
			false,
		);
	});

	it("refuses rows whose target entity does not resolve", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		const worker = await startedWorker(harness);
		await expect(
			worker.shouldRun?.(harness.runtime, runnableTask()),
		).resolves.toBe(false);
	});

	it("stops accepting work once the service is stopping", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addEntity(CONTACT_A, ["Alice"]);
		const service = await startService(harness);
		const worker = harness.workers.get("follow_up") as TaskWorker;

		await service.stop();

		await expect(
			worker.shouldRun?.(harness.runtime, runnableTask()),
		).resolves.toBe(false);
		await expect(
			worker.execute(harness.runtime, {}, runnableTask()),
		).resolves.toEqual({ preserveTask: true });
	});

	it("stop parks the registered worker so queued rows survive teardown", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		const service = await startService(harness);
		const worker = harness.workers.get("follow_up") as TaskWorker;

		await service.stop();
		const parked = harness.workers.get("follow_up");
		expect(parked).toBeDefined();
		expect(parked).not.toBe(worker);
		await expect(
			parked?.shouldRun?.(harness.runtime, runnableTask()),
		).resolves.toBe(false);
		await expect(
			parked?.execute(harness.runtime, {}, runnableTask()),
		).resolves.toEqual({ preserveTask: true });
		await expect(service.stop()).resolves.toBeUndefined();
	});

	it("writes a reminder memory and emits follow_up:due when executed", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addEntity(CONTACT_A, ["Alice"]);
		const worker = await startedWorker(harness);
		const task = harness.seedTask(runnableTask());

		const result = await worker.execute(harness.runtime, {}, task);
		expect(result).toBeUndefined();

		expect(harness.memories).toHaveLength(1);
		const { memory, table } = harness.memories[0] as {
			memory: {
				content: { text: string; type: string };
				metadata: Record<string, unknown>;
			};
			table?: string;
		};
		expect(table).toBe("reminders");
		expect(memory.content.text).toBe(
			"Follow-up reminder: Alice - Birthday. Call mom back",
		);
		expect(memory.content.type).toBe("follow_up_reminder");
		expect(memory.metadata.type).toBe(MemoryType.CUSTOM);
		expect(memory.metadata.source).toBe("relationships");
		expect(memory.metadata.targetEntityId).toBe(CONTACT_A);
		expect(memory.metadata.taskId).toBe("wx1");
		expect(memory.metadata.priority).toBe("high");

		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]?.event).toBe("follow_up:due");
		expect(harness.events[0]?.payload).toEqual({
			taskId: "wx1",
			taskName: "follow_up",
			entityId: CONTACT_A,
			message: "Call mom back",
		});

		const stored = harness.tasks.get("wx1");
		expect(stored?.tags).toEqual(["follow-up"]);
		expect(stored?.metadata?.status).toBe("executing");
	});

	it("substitutes defaults for missing message, reason, and priority", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addEntity(CONTACT_A, ["Alice"]);
		const worker = await startedWorker(harness);
		const task = harness.seedTask(
			makeTask("wx1", {
				tags: ["follow-up", "queue"],
				metadata: {
					targetEntityId: CONTACT_A,
					status: "pending",
					createdAt: iso(0),
				},
			}),
		);

		await worker.execute(harness.runtime, {}, task);

		const { memory } = harness.memories[0] as {
			memory: { content: { text: string }; metadata: Record<string, unknown> };
		};
		expect(memory.content.text).toBe(
			"Follow-up reminder: Alice - Check in. Time for a follow-up!",
		);
		expect(harness.events[0]?.payload.message).toBe("Time for a follow-up!");
		expect(memory.metadata.priority).toBe("medium");
	});

	it("preserves the row when the durable claim loses the race", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		harness.addEntity(CONTACT_A, ["Alice"]);
		const worker = await startedWorker(harness);
		const task = harness.seedTask(runnableTask());
		harness.refusedTransitions.add("wx1");

		await expect(worker.execute(harness.runtime, {}, task)).resolves.toEqual({
			preserveTask: true,
		});
		expect(harness.memories).toHaveLength(0);
		expect(harness.events).toHaveLength(0);
		expect(harness.tasks.get("wx1")?.metadata?.status).toBe("pending");
		expect(harness.tasks.get("wx1")?.tags).toContain("queue");
	});

	it("does not preserve rows whose target entity vanished before the claim", async () => {
		const harness = makeHarness();
		harness.addContact(CONTACT_A);
		const worker = await startedWorker(harness);
		const task = harness.seedTask(runnableTask());

		await expect(
			worker.execute(harness.runtime, {}, task),
		).resolves.toBeUndefined();
		expect(harness.memories).toHaveLength(0);
		expect(harness.events).toHaveLength(0);
		expect(harness.tasks.get("wx1")?.tags).toContain("queue");
	});
});

/**
 * Unit coverage for NotificationService over a mock runtime with an in-memory
 * cache and event bus: creation/validation, listing filters, read state,
 * groupKey collapse, expiry, retention-cap eviction, and cache rehydration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import type { AgentNotification } from "../types/notification.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { ServiceType } from "../types/service.ts";
import { NotificationService } from "./notification.ts";

interface EmittedEvent {
	runId: string;
	stream: string;
	data: Record<string, unknown>;
	agentId?: string;
}

function createRuntime(): {
	runtime: IAgentRuntime;
	cache: Map<string, unknown>;
	emitted: EmittedEvent[];
} {
	const cache = new Map<string, unknown>();
	const emitted: EmittedEvent[] = [];
	const bus = {
		emit: (event: EmittedEvent) => {
			emitted.push(event);
		},
	};
	const runtime = createMockRuntime({
		agentId: "00000000-0000-0000-0000-0000000000aa",
		getCache: async <T>(key: string): Promise<T | undefined> =>
			cache.get(key) as T | undefined,
		setCache: async <T>(key: string, value: T): Promise<boolean> => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
		getService: (type: string) =>
			type === ServiceType.AGENT_EVENT ? bus : null,
	});
	return { runtime, cache, emitted };
}

describe("NotificationService", () => {
	let ctx: ReturnType<typeof createRuntime>;
	let service: NotificationService;

	beforeEach(async () => {
		ctx = createRuntime();
		service = (await NotificationService.start(
			ctx.runtime,
		)) as NotificationService;
	});

	it("creates, stores, and returns a stamped notification", async () => {
		const n = await service.notify({
			title: "Deploy finished",
			body: "Build #42 deployed",
			category: "workflow",
			priority: "high",
			source: "workflow",
		});
		expect(n.id).toBeTruthy();
		expect(n.title).toBe("Deploy finished");
		expect(n.category).toBe("workflow");
		expect(n.priority).toBe("high");
		expect(n.readAt).toBeNull();
		expect(n.createdAt).toBeGreaterThan(0);
		expect(service.list()).toHaveLength(1);
		expect(service.getUnreadCount()).toBe(1);
	});

	it("rejects an empty title", async () => {
		await expect(service.notify({ title: "   " })).rejects.toThrow(/title/);
	});

	it("applies defaults for category/priority/source", async () => {
		const n = await service.notify({ title: "Hello" });
		expect(n.category).toBe("general");
		expect(n.priority).toBe("normal");
		expect(n.source).toBe("agent");
	});

	it("broadcasts on the agent event bus as a notification stream", async () => {
		await service.notify({ title: "Ping", priority: "urgent" });
		expect(ctx.emitted).toHaveLength(1);
		const event = ctx.emitted[0];
		expect(event.stream).toBe("notification");
		expect(event.data.type).toBe("notification");
		expect((event.data.notification as AgentNotification).title).toBe("Ping");
		expect(event.data.unreadCount).toBe(1);
	});

	it("still records when no event bus is present", async () => {
		const noBus = createRuntime();
		(noBus.runtime as unknown as { getService: () => null }).getService = () =>
			null;
		const svc = (await NotificationService.start(
			noBus.runtime,
		)) as NotificationService;
		const n = await svc.notify({ title: "Headless" });
		expect(n.title).toBe("Headless");
		expect(svc.list()).toHaveLength(1);
	});

	it("collapses notifications sharing a groupKey", async () => {
		await service.notify({ title: "Reminder 1", groupKey: "task:abc" });
		await service.notify({ title: "Reminder 2", groupKey: "task:abc" });
		const list = service.list();
		expect(list).toHaveLength(1);
		expect(list[0].title).toBe("Reminder 2");
	});

	it("lists newest-first and supports unreadOnly + category + limit filters", async () => {
		await service.notify({ title: "A", category: "task" });
		await service.notify({ title: "B", category: "workflow" });
		await service.notify({ title: "C", category: "task" });

		const all = service.list();
		expect(all.map((n) => n.title)).toEqual(["C", "B", "A"]);

		const tasksOnly = service.list({ category: "task" });
		expect(tasksOnly.map((n) => n.title)).toEqual(["C", "A"]);

		const limited = service.list({ limit: 2 });
		expect(limited).toHaveLength(2);

		await service.markRead(all[0].id);
		const unread = service.list({ unreadOnly: true });
		expect(unread.map((n) => n.title)).toEqual(["B", "A"]);
	});

	it("marks one and all read, updating unread count", async () => {
		const a = await service.notify({ title: "A" });
		await service.notify({ title: "B" });
		expect(service.getUnreadCount()).toBe(2);

		expect(await service.markRead(a.id)).toBe(true);
		expect(await service.markRead(a.id)).toBe(false); // already read
		expect(service.getUnreadCount()).toBe(1);

		expect(await service.markAllRead()).toBe(1);
		expect(service.getUnreadCount()).toBe(0);
		expect(await service.markAllRead()).toBe(0);
	});

	it("removes and clears", async () => {
		const a = await service.notify({ title: "A" });
		await service.notify({ title: "B" });
		expect(await service.remove(a.id)).toBe(true);
		expect(await service.remove(a.id)).toBe(false);
		expect(service.list()).toHaveLength(1);
		await service.clear();
		expect(service.list()).toHaveLength(0);
	});

	it("persists to the runtime cache and rehydrates on restart", async () => {
		await service.notify({ title: "Persisted", category: "system" });
		// A fresh service over the same cache should see the prior notification.
		const restarted = (await NotificationService.start(
			ctx.runtime,
		)) as NotificationService;
		const list = restarted.list();
		expect(list).toHaveLength(1);
		expect(list[0].title).toBe("Persisted");
		// system defaults to low/silent (§C.1): inbox history, no badge weight.
		expect(restarted.getUnreadCount()).toBe(0);
	});

	it("excludes a notification whose explicit expiresAt has passed", async () => {
		await service.notify({ title: "Gone", expiresAt: Date.now() - 1000 });
		await service.notify({ title: "Stays" });
		const list = service.list();
		expect(list).toHaveLength(1);
		expect(list[0].title).toBe("Stays");
		expect(service.getUnreadCount()).toBe(1);
	});

	it("retains a notification with a future expiresAt", async () => {
		await service.notify({ title: "Later", expiresAt: Date.now() + 60_000 });
		expect(service.list()).toHaveLength(1);
		expect(service.getUnreadCount()).toBe(1);
	});

	it("drops expired notifications on rehydrate", async () => {
		await service.notify({ title: "Expired", expiresAt: Date.now() - 1000 });
		await service.notify({ title: "Alive" });
		const restarted = (await NotificationService.start(
			ctx.runtime,
		)) as NotificationService;
		const list = restarted.list();
		expect(list).toHaveLength(1);
		expect(list[0].title).toBe("Alive");
		expect(restarted.getUnreadCount()).toBe(1);
	});

	it("hydrates empty when the cache adapter throws", async () => {
		const throwing = createRuntime();
		(
			throwing.runtime as unknown as { getCache: () => Promise<never> }
		).getCache = () => Promise.reject(new Error("no adapter"));
		const svc = (await NotificationService.start(
			throwing.runtime,
		)) as NotificationService;
		expect(svc.list()).toHaveLength(0);
	});

	it("evicts oldest beyond the retention cap", async () => {
		// Push more than the cap (300) and confirm the list stays bounded.
		for (let i = 0; i < 320; i++) {
			await service.notify({ title: `n${i}` });
		}
		const list = service.list();
		expect(list.length).toBeLessThanOrEqual(300);
		// Newest survived, oldest evicted.
		expect(list[0].title).toBe("n319");
		expect(list.some((n) => n.title === "n0")).toBe(false);
	});

	it("notify reflects unread count in the broadcast after collapse", async () => {
		await service.notify({ title: "R", groupKey: "g" });
		await service.notify({ title: "R2", groupKey: "g" });
		// Two emits, but the second reflects a single unread (collapsed).
		expect(ctx.emitted).toHaveLength(2);
		expect(ctx.emitted[1].data.unreadCount).toBe(1);
	});

	it("uses vi spies without leaking timers", () => {
		// Guard: the suite must not depend on fake timers.
		expect(vi.isFakeTimers()).toBe(false);
	});

	// ── §C.1 Triage tiers: category → priority producer defaults ────────────

	it("defaults an approval notification to the interrupt tier (high)", async () => {
		const n = await service.notify({
			title: "Approve send",
			category: "approval",
		});
		expect(n.priority).toBe("high");
	});

	it("defaults task/workflow notifications to the digest tier (normal)", async () => {
		const task = await service.notify({ title: "Task done", category: "task" });
		const wf = await service.notify({
			title: "Run done",
			category: "workflow",
		});
		expect(task.priority).toBe("normal");
		expect(wf.priority).toBe("normal");
	});

	it("defaults a routine system notification to the silent tier (low)", async () => {
		const n = await service.notify({
			title: "Backup done",
			category: "system",
		});
		expect(n.priority).toBe("low");
	});

	it("does not include silent-tier notifications in unread badge counts", async () => {
		await service.notify({ title: "Routine", priority: "low" });
		expect(service.list({ unreadOnly: true })).toHaveLength(1); // inbox history
		expect(service.getUnreadCount()).toBe(0); // no badge weight (§C.1)
		await service.notify({ title: "Digest", priority: "normal" });
		expect(service.getUnreadCount()).toBe(1);
	});

	it("lets a producer override the category default priority", async () => {
		// A system notification the producer deems urgent (e.g. disk full) keeps its
		// explicit priority; the category default only applies when none is given.
		const n = await service.notify({
			title: "Disk full",
			category: "system",
			priority: "urgent",
		});
		expect(n.priority).toBe("urgent");
	});

	// ── §C.1 Silent-tier default expiry ─────────────────────────────────────

	it("defaults a low-priority notification to a 24h expiry", async () => {
		const before = Date.now();
		const n = await service.notify({ title: "Routine", priority: "low" });
		const after = Date.now();
		expect(n.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
		expect(n.expiresAt).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
	});

	it("defaults expiry for a category that maps to the silent tier", async () => {
		// system → low → silent, so a bare system notification self-expires too.
		const n = await service.notify({
			title: "Log rotated",
			category: "system",
		});
		expect(n.priority).toBe("low");
		expect(n.expiresAt).toBeGreaterThan(Date.now());
	});

	it("never overrides a producer-set expiresAt on a low notification", async () => {
		const explicit = Date.now() + 5 * 60 * 1000;
		const n = await service.notify({
			title: "Quick note",
			priority: "low",
			expiresAt: explicit,
		});
		expect(n.expiresAt).toBe(explicit);
	});

	it("honors explicit null expiresAt on a low notification", async () => {
		const n = await service.notify({
			title: "Pinned silent note",
			priority: "low",
			expiresAt: null,
		});
		expect(n.expiresAt).toBeNull();
	});

	it("does NOT default an expiry for interrupt/digest tiers", async () => {
		const high = await service.notify({ title: "Approve", priority: "high" });
		const urgent = await service.notify({
			title: "Blocked",
			priority: "urgent",
		});
		const normal = await service.notify({ title: "Done", priority: "normal" });
		expect(high.expiresAt).toBeUndefined();
		expect(urgent.expiresAt).toBeUndefined();
		expect(normal.expiresAt).toBeUndefined();
	});

	// ── §C.3 Count-aware groupKey supersede ─────────────────────────────────

	it("carries data.count across same-groupKey supersede", async () => {
		await service.notify({ title: "1 new file", groupKey: "files" });
		await service.notify({ title: "another file", groupKey: "files" });
		await service.notify({ title: "3 new files", groupKey: "files" });
		const list = service.list();
		expect(list).toHaveLength(1);
		expect(list[0].title).toBe("3 new files");
		expect(list[0].data?.count).toBe(3);
	});

	it("leaves count absent for a first, un-superseded notification", async () => {
		const n = await service.notify({ title: "solo", groupKey: "once" });
		expect(n.data?.count).toBeUndefined();
	});

	it("honors a producer-set data.count instead of auto-incrementing", async () => {
		await service.notify({ title: "a", groupKey: "g" });
		const n = await service.notify({
			title: "b",
			groupKey: "g",
			data: { count: 12 },
		});
		expect(n.data?.count).toBe(12);
		expect(service.list()[0].data?.count).toBe(12);
	});

	it("does not add a count to notifications without a groupKey", async () => {
		await service.notify({ title: "x" });
		const n = await service.notify({ title: "y" });
		expect(n.data?.count).toBeUndefined();
		expect(service.list()).toHaveLength(2);
	});

	it("resets the count for a reused groupKey after the record expired away", async () => {
		// A prior record that has already expired should not seed the count of a
		// fresh notification reusing the same key.
		await service.notify({
			title: "old",
			groupKey: "reuse",
			expiresAt: Date.now() - 1000,
		});
		const n = await service.notify({ title: "new", groupKey: "reuse" });
		expect(n.data?.count).toBeUndefined();
		expect(service.list()).toHaveLength(1);
		expect(service.list()[0].title).toBe("new");
	});

	// ── §C.5 Acted-upon auto-read (markReadByGroupKey) ──────────────────────

	it("marks the notification for a groupKey read when its action completes", async () => {
		await service.notify({
			title: "Approval needed",
			category: "approval",
			groupKey: "approval:42",
		});
		expect(service.getUnreadCount()).toBe(1);
		const changed = await service.markReadByGroupKey("approval:42");
		expect(changed).toBe(1);
		expect(service.getUnreadCount()).toBe(0);
		expect(service.list()).toHaveLength(1); // read, not removed (§C.5)
		expect(service.list()[0].readAt).toBeTruthy();
	});

	it("broadcasts non-interruptive updates when marking a groupKey read", async () => {
		await service.notify({ title: "Approval", groupKey: "approval:7" });
		ctx.emitted.length = 0;
		await service.markReadByGroupKey("approval:7");
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0].data.type).toBe("notification_update");
		expect(ctx.emitted[0].data.unreadCount).toBe(0);
		const notification = ctx.emitted[0].data.notification as AgentNotification;
		expect(notification.readAt).toBeTruthy();
	});

	it("markReadByGroupKey returns 0 for an unknown or already-read group", async () => {
		expect(await service.markReadByGroupKey("nope")).toBe(0);
		await service.notify({ title: "done", groupKey: "g1" });
		await service.markReadByGroupKey("g1");
		// Second call: already read, nothing changes.
		expect(await service.markReadByGroupKey("g1")).toBe(0);
	});

	it("markReadByGroupKey does not reorder the inbox (§C.2)", async () => {
		await service.notify({ title: "A", groupKey: "ga" });
		await service.notify({ title: "B", groupKey: "gb" });
		await service.notify({ title: "C", groupKey: "gc" });
		await service.markReadByGroupKey("ga"); // read the oldest
		expect(service.list().map((n) => n.title)).toEqual(["C", "B", "A"]);
	});
});

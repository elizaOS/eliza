/**
 * Integration coverage for NotificationService over a real AgentRuntime,
 * in-memory database adapter, and AgentEventService. External systems are not involved.
 */

import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createCharacter } from "../src/character.ts";
import { ElizaError } from "../src/errors.js";
import { AgentRuntime } from "../src/runtime.ts";
import { AgentEventService } from "../src/services/agent-event.ts";
import { NotificationService } from "../src/services/notification.ts";
import type { AgentEventPayload } from "../src/types/agent-event.ts";
import {
	type AgentNotification,
	NATIVE_NOTIFICATION_PAGE_BYTES,
	NOTIFICATION_STREAM,
	type NotificationInboxSnapshot,
} from "../src/types/notification.ts";
import type { Plugin } from "../src/types/plugin.ts";
import { ServiceType } from "../src/types/service.ts";
import { stringToUuid as sqliteTestAgentId } from "../src/utils/string-to-uuid.js";

async function createRuntime(
	services: NonNullable<Plugin["services"]>,
	adapter: SQLiteDatabaseAdapter = SQLiteDatabaseAdapter.create(
		":memory:",
		sqliteTestAgentId("NotificationIntegrationAgent"),
	),
): Promise<{
	runtime: AgentRuntime;
	cleanup: () => Promise<void>;
}> {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "NotificationIntegrationAgent" }),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	await runtime.registerPlugin({
		name: "notification-integration-test",
		description: "Real notification services for integration coverage",
		services,
	});
	return {
		runtime,
		cleanup: async () => {
			await runtime.stop();
			await runtime.close();
		},
	};
}

describe("NotificationService", () => {
	let runtime: AgentRuntime;
	let cleanup: (() => Promise<void>) | undefined;
	let service: NotificationService;
	let unsubscribe: (() => void) | undefined;
	const emitted: AgentEventPayload[] = [];

	beforeAll(async () => {
		({ runtime, cleanup } = await createRuntime([
			AgentEventService,
			NotificationService,
		]));
		service = (await runtime.getServiceLoadPromise(
			ServiceType.NOTIFICATION,
		)) as NotificationService;
		const eventService = (await runtime.getServiceLoadPromise(
			ServiceType.AGENT_EVENT,
		)) as AgentEventService;
		unsubscribe = eventService.subscribe((event) => emitted.push(event));
	}, 180_000);

	afterAll(async () => {
		unsubscribe?.();
		await cleanup?.();
	});

	beforeEach(async () => {
		emitted.length = 0;
		await service.clear();
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

	it("preserves exact lifeops reminder bodies in storage and events while generic bodies normalize", async () => {
		const body = "\n  Exact alert body.  \n";
		const inputs = [
			{
				title: "Reminder",
				body,
				category: "reminder" as const,
				source: "lifeops",
			},
			{
				title: "Other reminder",
				body,
				category: "reminder" as const,
				source: "agent",
			},
			{
				title: "Other lifeops",
				body,
				category: "workflow" as const,
				source: "lifeops",
			},
		];
		for (const input of inputs) await service.notify(input);
		const expected = [body, body.trim(), body.trim()];
		expect(service.list().map((notification) => notification.body)).toEqual(
			[...expected].reverse(),
		);
		expect(
			emitted.map(
				(event) => (event.data.notification as AgentNotification).body,
			),
		).toEqual(expected);
		const restarted = (await NotificationService.start(
			runtime,
		)) as NotificationService;
		expect(restarted.list().map((notification) => notification.body)).toEqual(
			[...expected].reverse(),
		);
		await expect(
			service.notify({
				title: "Blank",
				body: " \n\t ",
				category: "reminder",
				source: "lifeops",
			}),
		).resolves.toMatchObject({ body: undefined });
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
		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.stream).toBe("notification");
		expect(event.data.type).toBe("notification");
		expect((event.data.notification as AgentNotification).title).toBe("Ping");
		expect(event.data.unreadCount).toBe(1);
	});

	it("does not broadcast success when durable persistence rejects", async () => {
		const originalSetCache = runtime.setCache.bind(runtime);
		runtime.setCache = async () => {
			throw new Error("injected notification persistence failure");
		};
		try {
			await expect(
				service.notify({ title: "Must not escape", priority: "urgent" }),
			).rejects.toThrow("injected notification persistence failure");
			expect(emitted).toEqual([]);
		} finally {
			runtime.setCache = originalSetCache;
		}
		expect(service.listIncludingExpired()).toEqual([]);
	});

	it("does not broadcast success when durable persistence returns false", async () => {
		const originalSetCache = runtime.setCache.bind(runtime);
		runtime.setCache = async () => false;
		try {
			await expect(service.notify({ title: "Rejected" })).rejects.toThrow(
				/persistence was rejected/,
			);
		} finally {
			runtime.setCache = originalSetCache;
		}
		expect(emitted).toEqual([]);
		expect(service.list()).toEqual([]);
	});

	it("keeps durable success when a live listener throws", async () => {
		const eventService = runtime.getService(
			ServiceType.AGENT_EVENT,
		) as AgentEventService;
		const stopThrowing = eventService.subscribe(() => {
			throw new Error("injected listener failure");
		});
		try {
			const notification = await service.notify({
				title: "Durable despite listener",
				priority: "urgent",
			});
			expect(service.listIncludingExpired()).toContainEqual(notification);
		} finally {
			stopThrowing();
		}
	});

	it("serializes overlapping writes across one rejected persistence", async () => {
		const originalSetCache = runtime.setCache.bind(runtime);
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let notificationWrites = 0;
		runtime.setCache = async (key, value) => {
			notificationWrites += 1;
			if (notificationWrites === 1) {
				await firstBlocked;
				throw new Error("injected first persistence failure");
			}
			return originalSetCache(key, value);
		};
		try {
			const first = service.notify({ title: "Rejected first" });
			const second = service.notify({ title: "Durable second" });
			releaseFirst?.();
			await expect(first).rejects.toThrow("injected first persistence failure");
			await expect(second).resolves.toMatchObject({ title: "Durable second" });
			expect(
				service.listIncludingExpired().map((entry) => entry.title),
			).toEqual(["Durable second"]);
			const stored = (
				await runtime.getCache<NotificationInboxSnapshot>(
					`notifications:${runtime.agentId}`,
				)
			)?.notifications;
			expect(stored?.map((entry) => entry.title)).toEqual(["Durable second"]);
		} finally {
			runtime.setCache = originalSetCache;
		}
	});

	it("serializes notify with concurrent removal without resurrecting the row", async () => {
		const removed = await service.notify({ title: "Remove me" });
		const originalSetCache = runtime.setCache.bind(runtime);
		let releaseNotify: (() => void) | undefined;
		const notifyBlocked = new Promise<void>((resolve) => {
			releaseNotify = resolve;
		});
		let writes = 0;
		runtime.setCache = async (key, value) => {
			writes += 1;
			if (writes === 1) await notifyBlocked;
			return originalSetCache(key, value);
		};
		try {
			const arriving = service.notify({ title: "Keep me" });
			const removal = service.remove(removed.id);
			releaseNotify?.();
			await expect(arriving).resolves.toMatchObject({ title: "Keep me" });
			await expect(removal).resolves.toBe(true);
			const stored = (
				await runtime.getCache<NotificationInboxSnapshot>(
					`notifications:${runtime.agentId}`,
				)
			)?.notifications;
			expect(stored?.map((entry) => entry.title)).toEqual(["Keep me"]);
			expect(service.list().map((entry) => entry.title)).toEqual(["Keep me"]);
		} finally {
			runtime.setCache = originalSetCache;
		}
	});

	it("reconciles a committed removal failure before the next queued notify", async () => {
		const removed = await service.notify({ title: "Committed removal" });
		const originalSetCache = runtime.setCache.bind(runtime);
		let injected = false;
		runtime.setCache = async (key, value) => {
			const result = await originalSetCache(key, value);
			if (!injected) {
				injected = true;
				throw new Error("injected post-removal failure");
			}
			return result;
		};
		try {
			const removal = service.remove(removed.id);
			const arriving = service.notify({ title: "After ambiguous removal" });
			await expect(removal).rejects.toThrow("injected post-removal failure");
			await expect(arriving).resolves.toMatchObject({
				title: "After ambiguous removal",
			});
			const stored = (
				await runtime.getCache<NotificationInboxSnapshot>(
					`notifications:${runtime.agentId}`,
				)
			)?.notifications;
			expect(stored?.map((entry) => entry.title)).toEqual([
				"After ambiguous removal",
			]);
			expect(service.list().map((entry) => entry.title)).toEqual([
				"After ambiguous removal",
			]);
		} finally {
			runtime.setCache = originalSetCache;
		}
	});

	it("awaits a rejected in-flight write before ensuring an exact grouped projection", async () => {
		const input = {
			title: "Approval needed",
			category: "approval",
			priority: "high" as const,
			groupKey: "approval:race",
			data: { requestId: "race", kind: "execute_workflow" },
		};
		const originalSetCache = runtime.setCache.bind(runtime);
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let writes = 0;
		runtime.setCache = async (key, value) => {
			writes += 1;
			if (writes === 1) {
				await firstBlocked;
				throw new Error("injected pending projection failure");
			}
			return originalSetCache(key, value);
		};
		try {
			const pending = service.notify(input);
			const ensured = service.ensureGroupedNotification(
				input,
				(entry) =>
					entry.title === input.title &&
					entry.groupKey === input.groupKey &&
					entry.data?.requestId === "race",
			);
			releaseFirst?.();
			await expect(pending).rejects.toThrow(
				"injected pending projection failure",
			);
			await expect(ensured).resolves.toMatchObject(input);
			const stored = (
				await runtime.getCache<NotificationInboxSnapshot>(
					`notifications:${runtime.agentId}`,
				)
			)?.notifications;
			expect(stored).toHaveLength(1);
			expect(stored?.[0]).toMatchObject(input);
			expect(stored?.[0]?.data).toEqual(input.data);
		} finally {
			runtime.setCache = originalSetCache;
		}
	});

	it("replaces a stale grouped projection without inheriting coalesced count", async () => {
		await service.notify({
			title: "Stale one",
			groupKey: "approval:stale",
			data: { requestId: "stale" },
		});
		await service.notify({
			title: "Stale two",
			groupKey: "approval:stale",
			data: { requestId: "stale" },
		});
		const expected = {
			title: "Approval needed",
			groupKey: "approval:stale",
			data: { requestId: "stale", kind: "execute_workflow" },
		};
		const ensured = await service.ensureGroupedNotification(
			expected,
			(entry) =>
				entry.title === expected.title &&
				JSON.stringify(entry.data) === JSON.stringify(expected.data),
		);
		expect(ensured.data).toEqual(expected.data);
		expect(service.listIncludingExpired()).toHaveLength(1);
	});

	it("retains every durable row through the exact-import boundary", async () => {
		for (let index = 0; index < 300; index += 1) {
			await service.notify({ title: `Existing ${index}` });
		}
		expect(service.getAvailableCapacity()).toBe(Number.POSITIVE_INFINITY);
		await service.notifyWithoutEviction({ title: "Must not evict" });
		const stored = (
			await runtime.getCache<NotificationInboxSnapshot>(
				`notifications:${runtime.agentId}`,
			)
		)?.notifications;
		expect(stored).toHaveLength(301);
		expect(stored?.[0]?.title).toBe("Existing 0");
		expect(stored?.at(-1)?.title).toBe("Must not evict");
	});

	it("shares durable coordinates across copies, restart, deletion and clear without changing stored records", async () => {
		const original = await service.notify({
			title: "Coordinates",
			data: { privateContext: "kept", ownerType: "clock" },
		});
		const firstPage = await service.listNativePage();
		expect(original.nativeSequence).toBe(firstPage.throughSequence);
		expect(original.nativeEpoch).toBe(firstPage.nativeEpoch);
		expect(service.list()[0]).toEqual(original);
		expect(emitted[0].data.notification).toEqual(original);
		expect(emitted[0].data.nativeNotification).toMatchObject({
			nativeEpoch: original.nativeEpoch,
			nativeSequence: original.nativeSequence,
			data: { ownerType: "clock" },
		});
		expect(emitted[0].data.nativeNotification).not.toHaveProperty(
			"data.privateContext",
		);
		const snapshot = await runtime.getCache<NotificationInboxSnapshot>(
			`notifications:${runtime.agentId}`,
		);
		expect(snapshot?.notifications[0]).not.toHaveProperty("nativeSequence");
		expect(snapshot?.notifications[0]).not.toHaveProperty("nativeEpoch");
		expect(snapshot?.notifications[0].data).toEqual(original.data);
		await service.remove(original.id);
		await service.clear();
		const restarted = (await NotificationService.start(
			runtime,
		)) as NotificationService;
		const restoredEmpty = await restarted.listNativePage();
		expect(restoredEmpty.nativeEpoch).toBe(original.nativeEpoch);
		const later = await service.notify({ title: "After empty restart" });
		expect(later.nativeEpoch).toBe(original.nativeEpoch);
		expect(later.nativeSequence).toBe((original.nativeSequence ?? 0) + 1);
		expect((await service.listNativePage()).notifications[0].id).toBe(later.id);
		// Restore the registered instance's view before the next shared fixture test.
		await restarted.stop();
	});

	it("reports a changed epoch before checking its older cursor against a lower counter", async () => {
		const current = await service.listNativePage();
		const oldCursor = {
			nativeEpoch: "10000000-0000-0000-0000-000000000001",
			afterSequence: current.throughSequence + 100,
			throughSequence: current.throughSequence + 100,
		};
		await expect(service.listNativePage(oldCursor)).rejects.toMatchObject({
			code: "NATIVE_NOTIFICATION_EPOCH_CHANGED",
			status: 409,
		});
		await expect(
			service.listNativePage({
				...oldCursor,
				nativeEpoch: current.nativeEpoch,
			}),
		).rejects.toMatchObject({ code: "INVALID_NATIVE_NOTIFICATION_CURSOR" });
	});

	it("pages a fixed append fence including read, low and expired rows despite deleted gaps", async () => {
		const a = await service.notify({ title: "Read", priority: "low" });
		const b = await service.notify({ title: "Deleted" });
		const c = await service.notify({
			title: "Expires later",
			expiresAt: Date.now() + 60_000,
		});
		await service.markRead(a.id);
		const first = await service.listNativePage({ limit: 1 });
		expect(first.complete).toBe(false);
		expect(first.notifications[0]).toMatchObject({ id: a.id, priority: "low" });
		expect(first.notifications[0].readAt).not.toBeNull();
		await service.remove(b.id);
		const afterFence = await service.notify({ title: "After captured fence" });
		const rest = await service.listNativePage({
			nativeEpoch: first.nativeEpoch,
			afterSequence: first.nextSequence,
			throughSequence: first.throughSequence,
			limit: 1,
		});
		expect(rest.notifications.map((n) => n.id)).toEqual([c.id]);
		expect(rest.complete).toBe(true);
		expect(rest.nextSequence).toBe(first.throughSequence);
		expect(afterFence.nativeSequence).toBeGreaterThan(rest.throughSequence);
		await service.clear();
		await service.notify({ title: "Already expired", expiresAt: 1 });
		expect(service.list()).toEqual([]);
		expect((await service.listNativePage()).notifications[0].expiresAt).toBe(1);
	});

	it("bounds encoded native pages without truncating producer content or their retained history", async () => {
		const body = "界".repeat(4096);
		for (let index = 0; index < 130; index++)
			await service.notify({
				title: `Page${index}`,
				body,
				data: { privateContext: "sensitive" },
			});
		let page = await service.listNativePage();
		const ids: string[] = [];
		const through = page.throughSequence,
			epoch = page.nativeEpoch;
		for (;;) {
			expect(
				new TextEncoder().encode(JSON.stringify(page)).byteLength,
			).toBeLessThanOrEqual(NATIVE_NOTIFICATION_PAGE_BYTES);
			expect(page.notifications.length).toBeLessThanOrEqual(128);
			for (const n of page.notifications) {
				expect(n.body).toBe(body);
				expect(n).not.toHaveProperty("data.privateContext");
				ids.push(n.id);
			}
			if (page.complete) break;
			const previous = page.nextSequence;
			page = await service.listNativePage({
				nativeEpoch: epoch,
				afterSequence: previous,
				throughSequence: through,
			});
			expect(page.nextSequence).toBeGreaterThan(previous);
		}
		expect(ids).toHaveLength(130);
		expect(new Set(ids).size).toBe(130);
		expect(page.nextSequence).toBe(through);
		await service.clear();
		const large = await service.notify({
			title: "Oversized",
			body: "x".repeat(4097),
		});
		expect(large.body).toHaveLength(4097);
		await expect(service.listNativePage()).rejects.toMatchObject({
			code: "NATIVE_NOTIFICATION_RECORD_TOO_LARGE",
			status: 413,
		});
		expect(emitted.at(-1)?.data.nativeProjectionError).toMatchObject({
			notificationId: large.id,
			nativeSequence: large.nativeSequence,
		});
		expect(emitted.at(-1)?.data.nativeNotification).toBeUndefined();
	});

	it("reconciles the sequence sidecar after ambiguous commits before the next queued write", async () => {
		const before = await service.listNativePage();
		const originalSetCache = runtime.setCache.bind(runtime);
		let once = true;
		runtime.setCache = async (key, value) => {
			const result = await originalSetCache(key, value);
			if (once) {
				once = false;
				throw new Error("after atomic sequence commit");
			}
			return result;
		};
		try {
			const first = service.notify({ title: "Committed but rejected" });
			const second = service.notify({ title: "Next queued write" });
			await expect(first).rejects.toThrow("after atomic sequence commit");
			await expect(second).resolves.toMatchObject({
				nativeSequence: before.throughSequence + 2,
			});
			const page = await service.listNativePage();
			expect(page.notifications.map((n) => n.nativeSequence)).toEqual([
				before.throughSequence + 1,
				before.throughSequence + 2,
			]);
			expect(emitted).toHaveLength(1);
		} finally {
			runtime.setCache = originalSetCache;
		}
	});

	it("blocks fences and later writes while an ambiguous commit cannot be read back", async () => {
		const before = await service.listNativePage();
		const originalSetCache = runtime.setCache.bind(runtime);
		const originalGetCache = runtime.getCache.bind(runtime);
		runtime.setCache = async () => {
			throw new Error("Unconfirmed write");
		};
		runtime.getCache = async () => {
			throw new Error("Unconfirmed readback");
		};
		try {
			await expect(service.notify({ title: "Uncertain" })).rejects.toThrow(
				/persistence and reconciliation failed/,
			);
			await expect(service.listNativePage()).rejects.toMatchObject({
				code: "NOTIFICATION_INBOX_UNAVAILABLE",
			});
			await expect(
				service.notify({ title: "Must remain blocked" }),
			).rejects.toThrow("Unconfirmed readback");
			expect(emitted).toEqual([]);
		} finally {
			runtime.setCache = originalSetCache;
			runtime.getCache = originalGetCache;
		}
		const recovered = await service.notify({ title: "Recovered" });
		expect(recovered.nativeSequence).toBe(before.throughSequence + 1);
		expect(
			(await service.listNativePage()).notifications.map((n) => n.id),
		).toEqual([recovered.id]);
	});

	it("waits for the atomic durable mutation before exposing a native fence", async () => {
		const originalSetCache = runtime.setCache.bind(runtime);
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		runtime.setCache = async (key, value) => {
			entered?.();
			await blocked;
			return originalSetCache(key, value);
		};
		try {
			const writing = service.notify({ title: "Pending durability" });
			await started;
			let settled = false;
			const reading = service.listNativePage().then((page) => {
				settled = true;
				return page;
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(settled).toBe(false);
			release?.();
			const notice = await writing;
			expect((await reading).throughSequence).toBe(notice.nativeSequence);
		} finally {
			release?.();
			runtime.setCache = originalSetCache;
		}
	});

	it("migrates legacy insertion order atomically and retains coordinates across restart", async () => {
		const fixture = await createRuntime([AgentEventService]);
		try {
			const key = `notifications:${fixture.runtime.agentId}`;
			const legacy = [
				{
					id: "10000000-0000-0000-0000-000000000001",
					title: "First stored",
					body: "  exact  ",
					category: "reminder",
					priority: "high",
					source: "fixture",
					createdAt: 500,
					data: { secret: "kept" },
				},
				{
					id: "10000000-0000-0000-0000-000000000002",
					title: "Second stored",
					category: "general",
					priority: "normal",
					source: "fixture",
					createdAt: 1,
					expiresAt: 0,
				},
			];
			await fixture.runtime.setCache(key, legacy);
			const originalSetCache = fixture.runtime.setCache.bind(fixture.runtime);
			fixture.runtime.setCache = async () => false;
			await expect(NotificationService.start(fixture.runtime)).rejects.toThrow(
				/persistence was rejected/,
			);
			expect(await fixture.runtime.getCache(key)).toEqual(legacy);
			fixture.runtime.setCache = originalSetCache;
			const migrated = (await NotificationService.start(
				fixture.runtime,
			)) as NotificationService;
			const page = await migrated.listNativePage();
			expect(
				page.notifications.map((n) => [n.title, n.nativeSequence]),
			).toEqual([
				["First stored", 1],
				["Second stored", 2],
			]);
			const stored =
				await fixture.runtime.getCache<NotificationInboxSnapshot>(key);
			expect(stored?.notifications).toEqual(legacy);
			const again = (await NotificationService.start(
				fixture.runtime,
			)) as NotificationService;
			expect(await again.listNativePage()).toEqual(page);
			await migrated.stop();
			await again.stop();
		} finally {
			await fixture.cleanup();
		}
	});

	it("still records when no event bus is present", async () => {
		const headless = await createRuntime([NotificationService]);
		try {
			const svc = (await headless.runtime.getServiceLoadPromise(
				ServiceType.NOTIFICATION,
			)) as NotificationService;
			const n = await svc.notify({ title: "Headless" });
			expect(n.title).toBe("Headless");
			expect(svc.list()).toHaveLength(1);
		} finally {
			await headless.cleanup();
		}
	});

	it("fails startup when persisted notification state cannot be read", async () => {
		class UnreadableCacheAdapter extends SQLiteDatabaseAdapter {
			override async getCaches<T>(_keys: string[]): Promise<Map<string, T>> {
				throw new ElizaError("notification cache unavailable", {
					code: "TEST_STORAGE_UNAVAILABLE",
				});
			}
		}

		const failing = await createRuntime(
			[NotificationService],
			UnreadableCacheAdapter.create(
				":memory:",
				sqliteTestAgentId("NotificationIntegrationAgent"),
			),
		);
		try {
			await expect(
				failing.runtime.getServiceLoadPromise(ServiceType.NOTIFICATION),
			).rejects.toThrow("Service notification not found or failed to start");
			expect(failing.runtime.getRecentReportedErrors()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						scope: "AgentRuntime.serviceStart",
						message: "notification cache unavailable",
						context: expect.objectContaining({
							serviceType: ServiceType.NOTIFICATION,
						}),
					}),
				]),
			);
			await expect(NotificationService.start(failing.runtime)).rejects.toThrow(
				"notification cache unavailable",
			);
		} finally {
			await failing.cleanup();
		}
	});

	it("recovers persisted history after a transient hydration failure", async () => {
		class TransientCacheAdapter extends SQLiteDatabaseAdapter {
			readAttempts = 0;

			override async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
				this.readAttempts += 1;
				if (this.readAttempts === 1) {
					throw new ElizaError("notification cache temporarily unavailable", {
						code: "TEST_STORAGE_UNAVAILABLE",
					});
				}
				return super.getCaches<T>(keys);
			}
		}

		const adapter = TransientCacheAdapter.create(
			":memory:",
			sqliteTestAgentId("NotificationIntegrationAgent"),
		);
		const transient = await createRuntime([NotificationService], adapter);
		try {
			await expect(
				transient.runtime.getServiceLoadPromise(ServiceType.NOTIFICATION),
			).rejects.toThrow("Service notification not found or failed to start");
			expect(
				transient.runtime.getServiceRegistrationStatus(
					ServiceType.NOTIFICATION,
				),
			).toBe("failed");

			const persisted = {
				id: "00000000-0000-0000-0000-0000000000cc",
				title: "Recovered history",
				category: "general",
				priority: "normal",
				source: "test",
				createdAt: Date.now(),
				readAt: null,
			} as AgentNotification;
			await transient.runtime.setCache(
				`notifications:${transient.runtime.agentId}`,
				[persisted],
			);

			const attempts = Array.from({ length: 8 }, () =>
				NotificationService.requestRecovery(transient.runtime),
			);
			expect(
				attempts.filter((attempt) => attempt.state === "started"),
			).toHaveLength(1);
			expect(
				attempts.filter((attempt) => attempt.state === "in-flight"),
			).toHaveLength(7);

			const recovered = (await transient.runtime.getServiceLoadPromise(
				ServiceType.NOTIFICATION,
			)) as NotificationService;
			expect(adapter.readAttempts).toBe(2);
			expect(
				recovered.list().map((notification) => notification.title),
			).toEqual(["Recovered history"]);
			expect(
				transient.runtime.getServiceRegistrationStatus(
					ServiceType.NOTIFICATION,
				),
			).toBe("registered");
		} finally {
			await transient.cleanup();
		}
	});

	it("backs off repeated recovery requests after a persistent failure", async () => {
		class UnavailableCacheAdapter extends SQLiteDatabaseAdapter {
			readAttempts = 0;

			override async getCaches<T>(_keys: string[]): Promise<Map<string, T>> {
				this.readAttempts += 1;
				throw new ElizaError("notification cache unavailable", {
					code: "TEST_STORAGE_UNAVAILABLE",
				});
			}
		}

		const adapter = UnavailableCacheAdapter.create(
			":memory:",
			sqliteTestAgentId("NotificationIntegrationAgent"),
		);
		const unavailable = await createRuntime([NotificationService], adapter);
		try {
			await expect(
				unavailable.runtime.getServiceLoadPromise(ServiceType.NOTIFICATION),
			).rejects.toThrow("failed to start");
			expect(
				NotificationService.requestRecovery(unavailable.runtime).state,
			).toBe("started");
			await expect(
				unavailable.runtime.getServiceLoadPromise(ServiceType.NOTIFICATION),
			).rejects.toThrow("failed to start");
			await Promise.resolve();
			expect(unavailable.runtime.getRecentReportedErrors()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						scope: "NotificationService.recovery",
						message: "Service notification not found or failed to start",
						context: expect.objectContaining({
							attempt: 1,
							retryAfterSeconds: 1,
						}),
					}),
				]),
			);

			const deferred = Array.from({ length: 10 }, () =>
				NotificationService.requestRecovery(unavailable.runtime),
			);
			expect(deferred.every((attempt) => attempt.state === "backoff")).toBe(
				true,
			);
			expect(deferred.every((attempt) => attempt.retryAfterSeconds === 1)).toBe(
				true,
			);
			expect(adapter.readAttempts).toBe(2);
		} finally {
			await unavailable.cleanup();
		}
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
			runtime,
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

	it("keeps expired durable rows addressable after rehydrate", async () => {
		await service.notify({ title: "Alive" });
		await service.notify({ title: "Expired", expiresAt: Date.now() + 10 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const restarted = (await NotificationService.start(
			runtime,
		)) as NotificationService;
		const list = restarted.list();
		expect(list).toHaveLength(1);
		expect(list[0].title).toBe("Alive");
		expect(restarted.getUnreadCount()).toBe(1);
		expect(
			restarted.listIncludingExpired().map((entry) => entry.title),
		).toEqual(["Expired", "Alive"]);
	});

	it("retains oldest and newest notifications beyond the former cap", async () => {
		for (let i = 0; i < 320; i++) {
			await service.notify({ title: `n${i}` });
		}
		const list = service.list();
		expect(list).toHaveLength(320);
		expect(list[0].title).toBe("n319");
		expect(list.some((n) => n.title === "n0")).toBe(true);
		let page = await service.listNativePage();
		const counts = [page.notifications.length];
		const titles = page.notifications.map((n) => n.title);
		while (!page.complete) {
			page = await service.listNativePage({
				nativeEpoch: page.nativeEpoch,
				afterSequence: page.nextSequence,
				throughSequence: page.throughSequence,
			});
			counts.push(page.notifications.length);
			titles.push(...page.notifications.map((n) => n.title));
		}
		expect(counts).toEqual([128, 128, 64]);
		expect(titles[0]).toBe("n0");
		expect(titles.at(-1)).toBe("n319");
	});

	it("notify reflects unread count in the broadcast after collapse", async () => {
		await service.notify({ title: "R", groupKey: "g" });
		await service.notify({ title: "R2", groupKey: "g" });
		// Two emits, but the second reflects a single unread (collapsed).
		expect(emitted).toHaveLength(2);
		expect(emitted[1].data.unreadCount).toBe(1);
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
		emitted.length = 0;
		await service.markReadByGroupKey("approval:7");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].data.type).toBe("notification_update");
		expect(emitted[0].data.unreadCount).toBe(0);
		const notification = emitted[0].data.notification as AgentNotification;
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

	describe("stop() drain and admission close", () => {
		let stopRuntime: AgentRuntime;
		let stopCleanup: () => Promise<void>;
		let stopService: NotificationService;
		let unsubscribeStopEvents: (() => void) | undefined;
		const stopEmitted: AgentEventPayload[] = [];

		beforeAll(async () => {
			const created = await createRuntime([
				AgentEventService,
				NotificationService,
			]);
			stopRuntime = created.runtime;
			stopCleanup = created.cleanup;
			stopService = (await stopRuntime.getServiceLoadPromise(
				ServiceType.NOTIFICATION,
			)) as NotificationService;
			const stopEventService = (await stopRuntime.getServiceLoadPromise(
				ServiceType.AGENT_EVENT,
			)) as AgentEventService;
			unsubscribeStopEvents = stopEventService.subscribe((event) =>
				stopEmitted.push(event),
			);
		}, 180_000);

		afterAll(async () => {
			unsubscribeStopEvents?.();
			// The runtime's own teardown path is exercised in the drain test; a
			// second full stop() is idempotent for the remaining lifecycle.
			await stopCleanup?.();
		});

		it("drains the durable write tail before stop() resolves", async () => {
			await stopService.clear();
			let releaseSetCache: (() => void) | undefined;
			const originalSetCache = stopRuntime.setCache.bind(stopRuntime);
			// Block the durable write of an accepted notify() mid-flight, then
			// call stop() while that write is still pending.
			(stopRuntime as { setCache: unknown }).setCache = (
				key: string,
				value: unknown,
			) => {
				if (key.startsWith("notifications:")) {
					return new Promise<boolean>((resolve) => {
						releaseSetCache = () => resolve(originalSetCache(key, value));
					});
				}
				return originalSetCache(key, value as never);
			};

			const accepted = stopService.notify({ title: "in-flight write" });
			// Wait until the blocked write actually holds the tail.
			await vi.waitFor(() => {
				expect(releaseSetCache).toBeDefined();
			});

			let stopped = false;
			const stopping = stopService.stop().then(() => {
				stopped = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(stopped).toBe(false);

			releaseSetCache?.();
			await Promise.all([accepted, stopping]);

			// The accepted write persisted and broadcast BEFORE stop resolved.
			expect(
				stopEmitted.some(
					(event) =>
						event.stream === NOTIFICATION_STREAM &&
						(event.data as { notification?: { title?: string } }).notification
							?.title === "in-flight write",
				),
			).toBe(true);
			// The durable write completed: the accepted record survived in the
			// durable inbox (it must be served again after restart), while the
			// in-memory list was cleared once the drained tail settled.
			const persisted = (
				await stopRuntime.getCache<NotificationInboxSnapshot>(
					`notifications:${stopRuntime.agentId}`,
				)
			)?.notifications;
			expect(persisted?.map((n) => n.title)).toEqual(["in-flight write"]);
			expect(stopService.listIncludingExpired()).toEqual([]);
			// Restore before the runtime-level cleanup stops services again.
			(stopRuntime as { setCache: unknown }).setCache = originalSetCache;
			// No post-stop clear(): write admission is closed by design; the
			// durable record stays for restart hydration and afterAll teardown
			// discards the whole test runtime.
		});

		it("rejects writes admitted after stop() with an explicit error", async () => {
			await stopService.stop();
			await expect(stopService.notify({ title: "too late" })).rejects.toThrow(
				/service is stopped/,
			);
			await expect(
				stopService.markRead("00000000-0000-4000-8000-000000000000"),
			).rejects.toThrow(/service is stopped/);
		});
	});
});

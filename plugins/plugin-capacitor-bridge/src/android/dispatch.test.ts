/**
 * Unit tests for the Android in-process route dispatch path.
 *
 * They drive `dispatchBufferedRequest` and `dispatchStreamingRequest` against a
 * fake route kernel, proving the loopback buffered envelope and incremental
 * streaming sink lifecycle without booting a runtime or device.
 */

import type { IAgentRuntime, Plugin, RouteHandlerResult } from "@elizaos/core";
import {
	AgentRuntime,
	createCharacter,
	InMemoryDatabaseAdapter,
	NotificationService,
	type Service,
	ServiceType,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { StdioBridgeStreamSink } from "../shared/stdio-bridge.ts";
import {
	type AndroidCoreRouteDeps,
	type AndroidDispatchRoute,
	type AndroidElizaConfigLike,
	dispatchBufferedRequest,
	dispatchStreamingRequest,
} from "./dispatch.ts";

const runtime = {} as IAgentRuntime;

async function createNotificationRuntime(
	services: NonNullable<Plugin["services"]> = [],
	adapter: InMemoryDatabaseAdapter = new InMemoryDatabaseAdapter(),
): Promise<{ runtime: AgentRuntime; cleanup: () => Promise<void> }> {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "AndroidNotificationDispatchTest" }),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	if (services.length > 0) {
		await runtime.registerPlugin({
			name: "android-notification-dispatch-test",
			description: "Real notification lifecycle for Android dispatch coverage",
			services,
		});
	}
	return {
		runtime,
		cleanup: async () => {
			await runtime.stop();
			await runtime.close();
		},
	};
}

/** A dispatchRoute that returns a fixed buffered result for the matched path. */
function fixedRoute(result: RouteHandlerResult | null): {
	route: AndroidDispatchRoute;
	calls: Array<Record<string, unknown>>;
} {
	const calls: Array<Record<string, unknown>> = [];
	const route: AndroidDispatchRoute = async (args) => {
		calls.push(args as unknown as Record<string, unknown>);
		return result;
	};
	return { route, calls };
}

function collectSink(): {
	sink: StdioBridgeStreamSink;
	events: Array<Record<string, unknown>>;
} {
	const events: Array<Record<string, unknown>> = [];
	const sink: StdioBridgeStreamSink = {
		emitResponse: (head) => events.push({ kind: "response", ...head }),
		emitChunk: (dataBase64) => events.push({ kind: "chunk", dataBase64 }),
		emitComplete: () => events.push({ kind: "complete" }),
		emitError: (message) => events.push({ kind: "error", message }),
	};
	return { sink, events };
}

function coreDeps(overrides: Partial<AndroidCoreRouteDeps> = {}): {
	deps: AndroidCoreRouteDeps;
	saved: AndroidElizaConfigLike[];
} {
	const saved: AndroidElizaConfigLike[] = [];
	const deps: AndroidCoreRouteDeps = {
		configFileExists: () => true,
		loadElizaConfig: () => ({}),
		saveElizaConfig: (config) => {
			saved.push(config);
		},
		hasPersistedFirstRunState: (config) =>
			(config as AndroidElizaConfigLike).meta?.firstRunComplete === true,
		...overrides,
	};
	return { deps, saved };
}

describe("dispatchBufferedRequest", () => {
	it("serves Android local startup app-core routes before dispatchRoute", async () => {
		const { route, calls } = fixedRoute(null);
		const { deps } = coreDeps({
			loadElizaConfig: () => ({ meta: { firstRunComplete: true } }),
		});
		const status = await dispatchBufferedRequest(
			runtime,
			route,
			{
				method: "GET",
				path: "/api/first-run/status",
			},
			deps,
		);
		expect(status.status).toBe(200);
		expect(JSON.parse(status.body)).toEqual({
			complete: true,
			cloudProvisioned: false,
			deploymentTarget: "local",
		});

		const auth = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/auth/me",
		});
		expect(auth.status).toBe(200);
		expect(JSON.parse(auth.body)).toMatchObject({
			identity: { id: "local-agent", kind: "machine" },
			session: { id: "local", kind: "local" },
			access: { mode: "local" },
		});

		expect(calls).toHaveLength(0);
	});

	it("reports first-run incomplete on a fresh Android install", async () => {
		const { route, calls } = fixedRoute(null);
		const { deps } = coreDeps({ configFileExists: () => false });
		const status = await dispatchBufferedRequest(
			runtime,
			route,
			{
				method: "GET",
				path: "/api/first-run/status",
			},
			deps,
		);
		expect(status.status).toBe(200);
		expect(JSON.parse(status.body)).toEqual({
			complete: false,
			cloudProvisioned: false,
			deploymentTarget: "local",
		});
		expect(calls).toHaveLength(0);
	});

	it("persists first-run completion and fails closed on write errors", async () => {
		const { route } = fixedRoute(null);
		const { deps, saved } = coreDeps({ configFileExists: () => false });
		const ok = await dispatchBufferedRequest(
			runtime,
			route,
			{
				method: "POST",
				path: "/api/first-run",
			},
			deps,
		);
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body)).toMatchObject({ ok: true, complete: true });
		expect(saved[0]?.meta?.firstRunComplete).toBe(true);

		const failing = coreDeps({
			saveElizaConfig: () => {
				throw new Error("disk full");
			},
		}).deps;
		const failed = await dispatchBufferedRequest(
			runtime,
			route,
			{
				method: "POST",
				path: "/api/first-run",
			},
			failing,
		);
		expect(failed.status).toBe(500);
		expect(JSON.parse(failed.body).error).toContain("disk full");
	});

	it("returns a non-404 response for Android local auth-bootstrap exchange", async () => {
		const { route, calls } = fixedRoute(null);
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "POST",
			path: "/api/auth/bootstrap/exchange",
			body: { token: "unused-local-token" },
		});
		expect(res.status).toBe(503);
		expect(JSON.parse(res.body)).toEqual({
			error: "db_unavailable",
			reason: "db_unavailable",
		});
		expect(calls).toHaveLength(0);
	});

	it("returns the loopback-shaped envelope for a JSON route", async () => {
		const { route, calls } = fixedRoute({
			status: 200,
			headers: { "content-type": "application/json; charset=utf-8" },
			body: { ok: true },
		});
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/custom-health",
		});
		expect(res.status).toBe(200);
		expect(res.statusText).toBe("OK");
		expect(res.bodyEncoding).toBe("base64");
		// body is stringified JSON; bodyBase64 round-trips to the same bytes.
		expect(JSON.parse(res.body)).toEqual({ ok: true });
		expect(Buffer.from(res.bodyBase64, "base64").toString("utf8")).toBe(
			res.body,
		);
		// dispatchRoute saw an authorized in-process call on the parsed path.
		expect(calls[0]?.inProcess).toBe(true);
		expect(calls[0]?.path).toBe("/api/custom-health");
	});

	it("splits query params off the path", async () => {
		const { route, calls } = fixedRoute({ status: 204 });
		await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/memories?table=facts&limit=5",
		});
		expect(calls[0]?.path).toBe("/api/memories");
		expect(calls[0]?.query).toEqual({ table: "facts", limit: "5" });
	});

	it("returns a 404 envelope when no route matches", async () => {
		const { route } = fixedRoute(null);
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/nope",
		});
		expect(res.status).toBe(404);
		expect(JSON.parse(res.body).code).toBe("not_found");
	});

	it("rejects an absolute or unsafe path", async () => {
		const { route } = fixedRoute({ status: 200 });
		await expect(
			dispatchBufferedRequest(runtime, route, {
				method: "GET",
				path: "http://evil/api",
			}),
		).rejects.toThrow(/path that starts with/);
		await expect(
			dispatchBufferedRequest(runtime, route, {
				method: "GET",
				path: "//evil",
			}),
		).rejects.toThrow(/path that starts with/);
	});

	it("preserves raw binary bytes losslessly through bodyBase64", async () => {
		// A non-UTF-8 byte sequence (e.g. WAV/PNG) must survive the bridge.
		const raw = Buffer.from([0xff, 0x00, 0x80, 0x7f]);
		const { route } = fixedRoute({ status: 200, body: raw });
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/tts/local-inference",
		});
		expect(Buffer.from(res.bodyBase64, "base64").equals(raw)).toBe(true);
	});

	it("serves the /api/notifications inbox from the runtime service over the UDS (#13550)", async () => {
		// The dashboard notification center hydrates from GET /api/notifications;
		// these routes are server-level (not runtime.routes), so without this the
		// loopback 404s and the widget stays empty on-device. The bridge must
		// serve them from the NotificationService BEFORE the plugin dispatcher.
		const seeded = [
			{ id: "n1", title: "Take the tour", readAt: null },
			{ id: "n2", title: "Get help", readAt: 123 },
		];
		let cleared = false;
		const readCalls: string[] = [];
		const notifierRuntime = {
			getService: (type: string) =>
				type === "notification"
					? {
							list: () => seeded,
							getUnreadCount: () => 1,
							markRead: (id: string) => {
								readCalls.push(id);
								return Promise.resolve(true);
							},
							markAllRead: () => Promise.resolve(1),
							remove: () => Promise.resolve(true),
							clear: () => {
								cleared = true;
								return Promise.resolve();
							},
						}
					: null,
		} as unknown as IAgentRuntime;
		const { route, calls } = fixedRoute(null);

		const list = await dispatchBufferedRequest(notifierRuntime, route, {
			method: "GET",
			path: "/api/notifications?limit=100",
		});
		expect(list.status).toBe(200);
		expect(JSON.parse(list.body)).toEqual({
			notifications: seeded,
			unreadCount: 1,
			serviceStatus: "ready",
		});
		// Served inline — the plugin dispatcher was never consulted.
		expect(calls).toHaveLength(0);

		const read = await dispatchBufferedRequest(notifierRuntime, route, {
			method: "POST",
			path: "/api/notifications/n1/read",
		});
		expect(read.status).toBe(200);
		expect(JSON.parse(read.body)).toEqual({ ok: true });
		expect(readCalls).toEqual(["n1"]);

		const clearRes = await dispatchBufferedRequest(notifierRuntime, route, {
			method: "DELETE",
			path: "/api/notifications",
		});
		expect(clearRes.status).toBe(200);
		expect(cleared).toBe(true);

		// Push-token registration is NOT ours — it must fall through.
		const push = await dispatchBufferedRequest(notifierRuntime, route, {
			method: "GET",
			path: "/api/notifications/push-tokens",
		});
		expect(calls).toHaveLength(1);
		expect((calls[0] as { path?: string }).path).toBe(
			"/api/notifications/push-tokens",
		);
		void push;
	});

	it("serves an explicitly disabled inbox when notification support is unregistered", async () => {
		const disabled = await createNotificationRuntime();
		try {
			const { route } = fixedRoute(null);
			const res = await dispatchBufferedRequest(disabled.runtime, route, {
				method: "GET",
				path: "/api/notifications",
			});
			expect(res.status).toBe(200);
			expect(JSON.parse(res.body)).toEqual({
				notifications: [],
				unreadCount: 0,
				serviceStatus: "disabled",
			});
		} finally {
			await disabled.cleanup();
		}
	});

	it("returns typed retryable 503 while the notification service is pending", async () => {
		const pending = await createNotificationRuntime([NotificationService]);
		try {
			const { route } = fixedRoute(null);
			const res = await dispatchBufferedRequest(pending.runtime, route, {
				method: "GET",
				path: "/api/notifications",
			});
			expect(res.status).toBe(503);
			expect(res.headers["retry-after"]).toBe("1");
			expect(JSON.parse(res.body)).toEqual({
				error: "Notification service is still starting",
				code: "NOTIFICATION_SERVICE_NOT_READY",
				retryAfter: 1,
			});
		} finally {
			await pending.cleanup();
		}
	});

	it("returns typed retryable 503 while the notification service is registering", async () => {
		let releaseStart = () => {};
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		class SlowNotificationService extends NotificationService {
			static override serviceType = ServiceType.NOTIFICATION;

			static override async start(runtime: IAgentRuntime): Promise<Service> {
				await startGate;
				return NotificationService.start(runtime);
			}
		}
		const registering = await createNotificationRuntime([
			SlowNotificationService,
		]);
		const loading = registering.runtime.getServiceLoadPromise(
			ServiceType.NOTIFICATION,
		);
		try {
			expect(
				registering.runtime.getServiceRegistrationStatus(
					ServiceType.NOTIFICATION,
				),
			).toBe("registering");
			const { route } = fixedRoute(null);
			const res = await dispatchBufferedRequest(registering.runtime, route, {
				method: "GET",
				path: "/api/notifications",
			});
			expect(res.status).toBe(503);
			expect(res.headers["retry-after"]).toBe("1");
			expect(JSON.parse(res.body).code).toBe("NOTIFICATION_SERVICE_NOT_READY");
		} finally {
			releaseStart();
			await loading;
			await registering.cleanup();
		}
	});

	it("recovers a failed service once and then serves its persisted rows", async () => {
		class TransientCacheAdapter extends InMemoryDatabaseAdapter {
			readAttempts = 0;

			override async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
				this.readAttempts += 1;
				if (this.readAttempts === 1) throw new Error("cache temporarily down");
				return super.getCaches<T>(keys);
			}
		}
		const adapter = new TransientCacheAdapter();
		const failedRuntime = await createNotificationRuntime(
			[NotificationService],
			adapter,
		);
		try {
			await expect(
				failedRuntime.runtime.getServiceLoadPromise(ServiceType.NOTIFICATION),
			).rejects.toThrow("failed to start");
			await failedRuntime.runtime.setCache(
				`notifications:${failedRuntime.runtime.agentId}`,
				[
					{
						id: "00000000-0000-0000-0000-0000000000dd",
						title: "Recovered Android history",
						category: "general",
						priority: "normal",
						source: "test",
						createdAt: Date.now(),
						readAt: null,
					},
				],
			);
			const { route } = fixedRoute(null);
			const failed = await dispatchBufferedRequest(
				failedRuntime.runtime,
				route,
				{
					method: "GET",
					path: "/api/notifications",
				},
			);
			expect(failed.status).toBe(503);
			expect(JSON.parse(failed.body).code).toBe("NOTIFICATION_SERVICE_FAILED");

			await failedRuntime.runtime.getServiceLoadPromise(
				ServiceType.NOTIFICATION,
			);
			const available = await dispatchBufferedRequest(
				failedRuntime.runtime,
				route,
				{ method: "GET", path: "/api/notifications" },
			);
			expect(available.status).toBe(200);
			expect(JSON.parse(available.body)).toMatchObject({
				serviceStatus: "ready",
				notifications: [{ title: "Recovered Android history" }],
			});
			expect(adapter.readAttempts).toBe(2);
		} finally {
			await failedRuntime.cleanup();
		}
	});
});

describe("dispatchStreamingRequest", () => {
	it("streams Android direct startup route responses without dispatchRoute", async () => {
		const { route, calls } = fixedRoute(null);
		const { deps } = coreDeps({ configFileExists: () => false });
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "GET", path: "/api/first-run/status" },
			sink,
			deps,
		);
		expect(events[0]).toMatchObject({ kind: "response", status: 200 });
		const body = JSON.parse(
			Buffer.from(events[1]?.dataBase64 as string, "base64").toString("utf8"),
		);
		expect(body).toMatchObject({
			complete: false,
			deploymentTarget: "local",
		});
		expect(calls).toHaveLength(0);
	});

	it("emits response head then base64 chunks for a return-shape stream", async () => {
		async function* frames(): AsyncGenerator<string> {
			yield "data: hello\n\n";
			yield "data: world\n\n";
		}
		const { route } = fixedRoute({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			stream: frames(),
		});
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/conversations/c/messages/stream" },
			sink,
		);
		expect(events[0]).toMatchObject({ kind: "response", status: 200 });
		expect(events.slice(1).map((e) => e.kind)).toEqual(["chunk", "chunk"]);
		expect(
			Buffer.from(events[1]?.dataBase64 as string, "base64").toString("utf8"),
		).toBe("data: hello\n\n");
	});

	it("forwards a legacy SSE handler's res.write fragments live via onChunk", async () => {
		// Simulate a legacy handler: dispatchRoute flushes fragments through the
		// onChunk sink before resolving (the real chat-stream handler's shape).
		const route: AndroidDispatchRoute = async (args) => {
			args.onChunk?.(Buffer.from("data: a\n\n", "utf8"));
			args.onChunk?.(Buffer.from("data: b\n\n", "utf8"));
			return { status: 200, headers: {}, body: "" };
		};
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/conversations/c/messages/stream" },
			sink,
		);
		// Head emitted on the first write, then one chunk per fragment.
		expect(events[0]?.kind).toBe("response");
		const chunks = events.filter((e) => e.kind === "chunk");
		expect(chunks).toHaveLength(2);
		expect(
			Buffer.from(chunks[0]?.dataBase64 as string, "base64").toString("utf8"),
		).toBe("data: a\n\n");
	});

	it("streams a non-streaming buffered result as a single chunk", async () => {
		const { route } = fixedRoute({
			status: 200,
			headers: { "content-type": "application/json" },
			body: { done: true },
		});
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/agents/x/message" },
			sink,
		);
		expect(events[0]?.kind).toBe("response");
		const chunks = events.filter((e) => e.kind === "chunk");
		expect(chunks).toHaveLength(1);
		expect(
			JSON.parse(
				Buffer.from(chunks[0]?.dataBase64 as string, "base64").toString("utf8"),
			),
		).toEqual({ done: true });
	});

	it("emits a 404 head + body when no route matches a stream", async () => {
		const { route } = fixedRoute(null);
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/nope/stream" },
			sink,
		);
		expect(events[0]).toMatchObject({ kind: "response", status: 404 });
	});
});

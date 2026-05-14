import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CarrotWorkerMessage } from "@elizaos/electrobun-carrots";
import { describe, expect, it } from "vitest";
import { CarrotManager, type CarrotWorkerHandle } from "./carrots";

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "electrobun-carrot-host-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writePayload(root: string): string {
	const payloadDir = join(root, "payload");
	mkdirSync(join(payloadDir, "views"), { recursive: true });
	writeFileSync(
		join(payloadDir, "carrot.json"),
		JSON.stringify({
			id: "bunny.search",
			name: "Search",
			version: "1.0.0",
			description: "Search helper",
			mode: "window",
			permissions: {
				host: { notifications: true },
				bun: { read: true },
			},
			view: {
				relativePath: "views/index.html",
				title: "Search",
				width: 900,
				height: 700,
			},
			worker: { relativePath: "worker.ts" },
		}),
		"utf8",
	);
	writeFileSync(join(payloadDir, "worker.ts"), "postMessage({type:'ready'});");
	writeFileSync(join(payloadDir, "views", "index.html"), "<div>Search</div>");
	return payloadDir;
}

class FakeWorkerHandle implements CarrotWorkerHandle {
	readonly messages: CarrotWorkerMessage[] = [];
	terminated = false;
	private messageListener: ((message: CarrotWorkerMessage) => void) | null =
		null;
	private errorListener: ((error: Error) => void) | null = null;

	postMessage(message: CarrotWorkerMessage): void {
		this.messages.push(message);
	}

	terminate(): void {
		this.terminated = true;
	}

	onMessage(listener: (message: CarrotWorkerMessage) => void): void {
		this.messageListener = listener;
	}

	onError(listener: (error: Error) => void): void {
		this.errorListener = listener;
	}

	emit(message: CarrotWorkerMessage): void {
		this.messageListener?.(message);
	}

	fail(message: string): void {
		this.errorListener?.(new Error(message));
	}
}

describe("CarrotManager", () => {
	it("installs, lists, snapshots, and uninstalls carrots", () =>
		withTempDir((dir) => {
			const events: string[] = [];
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				now: () => 1700000000000,
				events: {
					storeChanged: (snapshot) => {
						events.push(`store:${snapshot.carrots.length}`);
					},
				},
			});

			const installed = manager.installFromDirectory({
				sourceDir: writePayload(dir),
				devMode: true,
			});

			expect(installed.id).toBe("bunny.search");
			expect(installed.sourceKind).toBe("local");
			expect(manager.listCarrots()).toEqual([
				{
					id: "bunny.search",
					name: "Search",
					description: "Search helper",
					version: "1.0.0",
					mode: "window",
					permissions: [
						"host:notifications",
						"bun:read",
						"isolation:shared-worker",
					],
					status: "installed",
					devMode: true,
				},
			]);
			expect(manager.getStoreSnapshot().carrots).toHaveLength(1);

			const result = manager.uninstall("bunny.search");
			expect(result.removed).toBe(true);
			expect(result.carrot?.id).toBe("bunny.search");
			expect(manager.listCarrots()).toEqual([]);
			expect(events).toEqual(["store:1", "store:0"]);
		}));

	it("starts workers with init context and stops them", () =>
		withTempDir((dir) => {
			const worker = new FakeWorkerHandle();
			const workerEvents: string[] = [];
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => worker },
				now: () => 1700000000000 + workerEvents.length,
				events: {
					workerChanged: (status) => {
						workerEvents.push(`${status.id}:${status.state}`);
					},
				},
			});
			manager.installFromDirectory({ sourceDir: writePayload(dir) });

			expect(manager.startWorker("bunny.search")).toMatchObject({
				id: "bunny.search",
				state: "running",
			});
			expect(worker.messages[0]).toMatchObject({
				type: "init",
				manifest: { id: "bunny.search" },
				context: {
					permissions: [
						"host:notifications",
						"bun:read",
						"isolation:shared-worker",
					],
				},
			});

			worker.emit({
				type: "action",
				action: "log",
				payload: { level: "info", message: "hello" },
			});
			const carrot = manager.getCarrot("bunny.search");
			if (!carrot) throw new Error("Expected carrot snapshot.");
			const status = manager.stopWorker("bunny.search");
			expect(status.state).toBe("stopped");
			expect(worker.terminated).toBe(true);
			expect(
				readFileSync(
					join(dir, "store", "bunny.search", "data", "logs.txt"),
					"utf8",
				),
			).toBe("[info] hello\n");
			expect(manager.getLogs("bunny.search")).toMatchObject({
				id: "bunny.search",
				text: "[info] hello\n",
				truncated: false,
			});
			expect(manager.getLogs("bunny.search", 6)).toMatchObject({
				id: "bunny.search",
				text: "hello\n",
				truncated: true,
			});
			expect(workerEvents).toEqual([
				"bunny.search:starting",
				"bunny.search:running",
				"bunny.search:stopped",
			]);
		}));

	it("records worker errors", () =>
		withTempDir((dir) => {
			const worker = new FakeWorkerHandle();
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => worker },
				now: () => 1700000000000,
			});
			manager.installFromDirectory({ sourceDir: writePayload(dir) });
			manager.startWorker("bunny.search");

			worker.fail("boom");

			expect(manager.getWorkerStatus("bunny.search")).toMatchObject({
				id: "bunny.search",
				state: "error",
				error: "boom",
			});
		}));

	it("dispatches host-request list-carrots back to the worker", () =>
		withTempDir((dir) => {
			const worker = new FakeWorkerHandle();
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => worker },
				now: () => 1700000000000,
			});
			manager.installFromDirectory({ sourceDir: writePayload(dir) });
			manager.startWorker("bunny.search");

			worker.emit({
				type: "host-request",
				requestId: 1,
				method: "list-carrots",
			});

			return new Promise<void>((resolve, reject) => {
				setTimeout(() => {
					try {
						const response = worker.messages.find(
							(m) => m.type === "host-response" && m.requestId === 1,
						);
						expect(response).toBeDefined();
						expect(response).toMatchObject({
							type: "host-response",
							requestId: 1,
							success: true,
						});
						const list = (
							response as unknown as { payload: Array<{ id: string }> }
						).payload;
						expect(list).toHaveLength(1);
						expect(list[0]).toMatchObject({ id: "bunny.search" });
						resolve();
					} catch (error) {
						reject(error);
					}
				}, 10);
			});
		}));

	it("seeds and replaces the carrot auth token on demand", () =>
		withTempDir((dir) => {
			const previousToken = process.env.ELIZA_API_TOKEN;
			process.env.ELIZA_API_TOKEN = "carrot-test-token";
			const worker = new FakeWorkerHandle();
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => worker },
				now: () => 1700000000000,
			});
			manager.installFromDirectory({ sourceDir: writePayload(dir) });
			manager.startWorker("bunny.search");

			worker.emit({
				type: "host-request",
				requestId: 11,
				method: "get-auth-token",
			});
			worker.emit({
				type: "host-request",
				requestId: 12,
				method: "set-auth-token",
				params: { token: "rotated-token" },
			});
			worker.emit({
				type: "host-request",
				requestId: 13,
				method: "get-auth-token",
			});

			return new Promise<void>((resolve, reject) => {
				setTimeout(() => {
					try {
						const initial = worker.messages.find(
							(m) => m.type === "host-response" && m.requestId === 11,
						);
						expect(initial).toMatchObject({
							success: true,
							payload: { token: "carrot-test-token" },
						});
						const setResp = worker.messages.find(
							(m) => m.type === "host-response" && m.requestId === 12,
						);
						expect(setResp).toMatchObject({
							success: true,
							payload: { ok: true },
						});
						const rotated = worker.messages.find(
							(m) => m.type === "host-response" && m.requestId === 13,
						);
						expect(rotated).toMatchObject({
							success: true,
							payload: { token: "rotated-token" },
						});
						resolve();
					} catch (error) {
						reject(error);
					} finally {
						if (previousToken === undefined) {
							delete process.env.ELIZA_API_TOKEN;
						} else {
							process.env.ELIZA_API_TOKEN = previousToken;
						}
					}
				}, 10);
			});
		}));

	it("returns an error response for unknown host-request methods", () =>
		withTempDir((dir) => {
			const worker = new FakeWorkerHandle();
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => worker },
				now: () => 1700000000000,
			});
			manager.installFromDirectory({ sourceDir: writePayload(dir) });
			manager.startWorker("bunny.search");

			worker.emit({
				type: "host-request",
				requestId: 42,
				// Force an unknown method through the dispatcher to assert the
				// error-response path. Casting through unknown is necessary
				// because the type union only allows known methods.
				method: "totally-made-up" as unknown as "list-carrots",
			});

			return new Promise<void>((resolve, reject) => {
				setTimeout(() => {
					try {
						const response = worker.messages.find(
							(m) => m.type === "host-response" && m.requestId === 42,
						);
						expect(response).toMatchObject({
							type: "host-response",
							requestId: 42,
							success: false,
						});
						expect((response as { error?: string }).error).toContain(
							"totally-made-up",
						);
						resolve();
					} catch (error) {
						reject(error);
					}
				}, 10);
			});
		}));

	it("routes emit-carrot-event between two running carrots", () =>
		withTempDir((dir) => {
			const workerA = new FakeWorkerHandle();
			const workerB = new FakeWorkerHandle();
			let nextWorker: FakeWorkerHandle = workerA;
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => nextWorker },
				now: () => 1700000000000,
			});

			// Install bunny.search (worker A)
			manager.installFromDirectory({ sourceDir: writePayload(dir) });
			manager.startWorker("bunny.search");

			// Install a second carrot (worker B) with a different id
			const secondDir = join(dir, "second");
			mkdirSync(join(secondDir, "views"), { recursive: true });
			writeFileSync(
				join(secondDir, "carrot.json"),
				JSON.stringify({
					id: "bunny.timer",
					name: "Timer",
					version: "1.0.0",
					description: "Timer helper",
					mode: "background",
					permissions: { host: {}, bun: {} },
					view: {
						relativePath: "views/index.html",
						title: "Timer",
						width: 240,
						height: 160,
					},
					worker: { relativePath: "worker.ts" },
				}),
				"utf8",
			);
			writeFileSync(
				join(secondDir, "worker.ts"),
				"postMessage({type:'ready'});",
			);
			writeFileSync(join(secondDir, "views", "index.html"), "<div>Timer</div>");
			nextWorker = workerB;
			manager.installFromDirectory({ sourceDir: secondDir });
			manager.startWorker("bunny.timer");

			// A emits to B
			workerA.emit({
				type: "action",
				action: "emit-carrot-event",
				payload: {
					carrotId: "bunny.timer",
					name: "ping",
					payload: { count: 1 },
				},
			});

			const eventMsg = workerB.messages.find((m) => m.type === "event");
			expect(eventMsg).toMatchObject({
				type: "event",
				name: "ping",
				payload: { count: 1 },
			});

			// Emit to a non-running carrot — should be dropped silently (warning only)
			workerA.emit({
				type: "action",
				action: "emit-carrot-event",
				payload: {
					carrotId: "does-not-exist",
					name: "ghost",
				},
			});
			// workerB should NOT have received anything new
			const eventsAfter = workerB.messages.filter((m) => m.type === "event");
			expect(eventsAfter).toHaveLength(1);
		}));

	it("ignores late worker events after stop", () =>
		withTempDir((dir) => {
			const worker = new FakeWorkerHandle();
			const workerEvents: string[] = [];
			const manager = new CarrotManager({
				storeRoot: join(dir, "store"),
				workerRunner: { start: () => worker },
				now: () => 1700000000000 + workerEvents.length,
				events: {
					workerChanged: (status) => {
						workerEvents.push(`${status.id}:${status.state}`);
					},
				},
			});
			manager.installFromDirectory({ sourceDir: writePayload(dir) });
			manager.startWorker("bunny.search");
			manager.stopWorker("bunny.search");

			worker.emit({ type: "ready" });
			worker.fail("late boom");

			expect(manager.getWorkerStatus("bunny.search")).toMatchObject({
				id: "bunny.search",
				state: "stopped",
				error: null,
			});
			expect(workerEvents).toEqual([
				"bunny.search:starting",
				"bunny.search:running",
				"bunny.search:stopped",
			]);
		}));
});

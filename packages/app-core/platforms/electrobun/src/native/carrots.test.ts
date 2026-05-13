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

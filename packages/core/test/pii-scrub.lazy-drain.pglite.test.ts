/**
 * The PII scrub service creates its PII_SCRUB_DRAIN repeat task on the first
 * scrub request, not at start. An agent that never asks for a scrub then has
 * no idle drain reading and writing the tasks table. Drives the real runtime,
 * event bus, task store and in-memory PGlite adapter.
 */

import pluginSql from "@elizaos/plugin-sql";
import { expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime";
import {
	getScrubMarker,
	scrubMarkerKeyForContent,
} from "../src/security/pii-scrub-markers";
import { PiiScrubService } from "../src/services/pii-scrub";
import { EventType } from "../src/types/events";

const DRAIN_TASK = "PII_SCRUB_DRAIN";

it("retries a failed lazy drain start and retires pending requests on stop", async () => {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = `memory://pii-scrub-lazy-${process.pid}`;
	const runtime = new AgentRuntime({
		character: { name: "PiiScrubLazy", bio: ["Tests lazy PII drain start"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
	const createTask = runtime.createTask.bind(runtime);
	let failFirstDrain = true;
	runtime.createTask = async (...args) => {
		if (args[0].name === DRAIN_TASK && failFirstDrain) {
			failFirstDrain = false;
			throw new Error("Transient drain task write failure");
		}
		return createTask(...args);
	};
	try {
		expect(await runtime.getTasksByName(DRAIN_TASK)).toEqual([]);
		expect(runtime.getTaskWorker(DRAIN_TASK)).toBeUndefined();

		const request = {
			runtime,
			source: "test",
			content: "Call Ada Lovelace at 555-0100.",
			rulesetVersion: "lazy-drain-test",
			candidateSpans: ["Ada Lovelace", "555-0100"],
		};
		await expect(
			runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, request),
		).rejects.toThrow("Transient drain task write failure");
		expect(await runtime.getTasksByName(DRAIN_TASK)).toEqual([]);
		expect(service.getQueueSize()).toBe(1);
		await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, request);

		const tasks = await runtime.getTasksByName(DRAIN_TASK);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.tags).toEqual(["queue", "repeat"]);
		expect(runtime.getTaskWorker(DRAIN_TASK)).toBeDefined();
		expect(service.getQueueSize()).toBe(2);

		let releaseRead = () => {};
		let readStarted = () => {};
		const heldRead = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const enteredRead = new Promise<void>((resolve) => {
			readStarted = resolve;
		});
		const lateContent = "A scrub request whose marker read overlaps stop.";
		const lateKey = scrubMarkerKeyForContent(
			lateContent,
			request.rulesetVersion,
		);
		const getCache = runtime.getCache.bind(runtime);
		runtime.getCache = async <T>(key: string): Promise<T | undefined> => {
			if (key === lateKey) {
				readStarted();
				await heldRead;
			}
			return getCache<T>(key);
		};
		const lateRequest = runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, {
			...request,
			content: lateContent,
		});
		await enteredRead;
		process.env.ELIZA_FAST_SHUTDOWN = "1";
		let releaseDelete = () => {};
		let deleteStarted = () => {};
		const heldDelete = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		const enteredDelete = new Promise<void>((resolve) => {
			deleteStarted = resolve;
		});
		const deleteTask = runtime.deleteTask.bind(runtime);
		runtime.deleteTask = async (id) => {
			if (id === tasks[0]?.id) {
				deleteStarted();
				await heldDelete;
			}
			return deleteTask(id);
		};
		const firstStop = service.stop();
		await enteredDelete;
		let secondStopped = false;
		const secondStop = service.stop().then(() => {
			secondStopped = true;
		});
		try {
			await Promise.resolve();
			expect(secondStopped).toBe(false);
		} finally {
			releaseDelete();
		}
		await Promise.all([firstStop, secondStop]);
		releaseRead();
		await lateRequest;
		expect(await runtime.getTasksByName(DRAIN_TASK)).toEqual([]);
		expect(service.getQueueSize()).toBe(0);
	} finally {
		process.env.ELIZA_FAST_SHUTDOWN = "1";
		await service.stop();
		delete process.env.ELIZA_FAST_SHUTDOWN;
		await runtime.stop();
		await runtime.close();
		if (previousDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
		else process.env.PGLITE_DATA_DIR = previousDataDir;
	}
});

it.each([
	"first marker write refusal",
	"permanent marker write refusal",
	"committed observer rejection",
] as const)("settles a scrub item after %s", async (mode) => {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = `memory://pii-scrub-settlement-${process.pid}-${mode.replaceAll(" ", "-")}`;
	const runtime = new AgentRuntime({
		character: { name: "ScrubReceipt", bio: ["Tests scrub marker settlement"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
	const content = "Synthetic scrub receipt fixture.";
	const rulesetVersion = "receipt-fixture";
	const markerKey = scrubMarkerKeyForContent(content, rulesetVersion);
	const setCaches = runtime.adapter.setCaches.bind(runtime.adapter);
	const getCaches = runtime.adapter.getCaches.bind(runtime.adapter);
	const permanent = mode === "permanent marker write refusal";
	const rejectsObserver = mode === "committed observer rejection";
	const completionReceipts: boolean[] = [];
	const failures: unknown[] = [];
	let reads = 0;
	let writes = 0;
	try {
		runtime.adapter.getCaches = async <T>(keys: string[]) => {
			if (keys.includes(markerKey)) reads++;
			return getCaches<T>(keys);
		};
		runtime.adapter.setCaches = async <T>(
			entries: Array<{ key: string; value: T }>,
		) => {
			if (entries.length === 1 && entries[0]?.key === markerKey) {
				writes++;
				if (permanent || (!rejectsObserver && writes === 1)) return false;
			}
			return setCaches(entries);
		};
		runtime.registerEvent(EventType.PII_SCRUB_COMPLETED, async () => {
			completionReceipts.push((await getCaches([markerKey])).has(markerKey));
			if (rejectsObserver) throw new Error(content);
		});
		runtime.registerEvent(EventType.PII_SCRUB_FAILED, async ({ error }) => {
			failures.push(error);
		});
		const request = { runtime, source: "test", content, rulesetVersion };
		await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, request);
		const [task] = await runtime.getTasksByName(DRAIN_TASK);
		const worker = runtime.getTaskWorker(DRAIN_TASK);
		if (!worker || !task) throw new Error("Scrub drain not registered");
		await worker.execute(runtime, {}, task);

		expect(completionReceipts).toEqual(permanent ? [] : [true]);
		expect(writes).toBe(permanent ? 4 : rejectsObserver ? 1 : 2);
		expect(reads).toBe(writes + 1);
		expect(failures).toHaveLength(permanent ? 1 : 0);
		const marker = await getScrubMarker(runtime, content, rulesetVersion);
		if (permanent) {
			expect(marker).toBeUndefined();
			expect(runtime.getRecentReportedErrors()).toContainEqual(
				expect.objectContaining({
					scope: "pii-scrub",
					code: "PII_SCRUB_MARKER_WRITE_REFUSED",
				}),
			);
		} else {
			expect(marker).toMatchObject({ rulesetVersion, tier0Only: true });
			await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, request);
			expect(service.getQueueSize()).toBe(0);
		}
		if (rejectsObserver) {
			expect(
				runtime
					.getRecentReportedErrors()
					.filter(
						(error) => error.scope === "PiiScrubService.notifyCompletion",
					),
			).toMatchObject([
				{
					code: "PII_SCRUB_COMPLETION_OBSERVER_FAILED",
					message: "A scrub completion observer failed",
				},
			]);
		}
	} finally {
		runtime.adapter.getCaches = getCaches;
		runtime.adapter.setCaches = setCaches;
		await service.stop();
		await runtime.stop();
		await runtime.close();
		if (previousDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
		else process.env.PGLITE_DATA_DIR = previousDataDir;
	}
});

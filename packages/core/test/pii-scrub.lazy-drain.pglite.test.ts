/**
 * The PII scrub service creates its PII_SCRUB_DRAIN repeat task on the first
 * scrub request, not at start. An agent that never asks for a scrub then has
 * no idle drain reading and writing the tasks table. Drives the real runtime,
 * event bus, task store and in-memory PGlite adapter.
 */

import pluginSql from "@elizaos/plugin-sql";
import { expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime";
import { PiiScrubService } from "../src/services/pii-scrub";
import { EventType } from "../src/types/events";

const DRAIN_TASK = "PII_SCRUB_DRAIN";

it("starts the scrub drain task on the first request", async () => {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = `memory://pii-scrub-lazy-${process.pid}`;
	const runtime = new AgentRuntime({
		character: { name: "PiiScrubLazy", bio: ["Tests lazy PII drain start"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
	try {
		expect(await runtime.getTasksByName(DRAIN_TASK)).toEqual([]);
		expect(runtime.getTaskWorker(DRAIN_TASK)).toBeUndefined();

		await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, {
			runtime,
			source: "test",
			content: "Call Ada Lovelace at 555-0100.",
			rulesetVersion: "lazy-drain-test",
			candidateSpans: ["Ada Lovelace", "555-0100"],
		});

		const tasks = await runtime.getTasksByName(DRAIN_TASK);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.tags).toEqual(["queue", "repeat"]);
		expect(runtime.getTaskWorker(DRAIN_TASK)).toBeDefined();
		expect(service.getQueueSize()).toBe(1);
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

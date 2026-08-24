/**
 * Exercises the runtime-scoped deferred-message scheduler registry with real
 * registration, lookup, duplicate rejection, disposal, and isolation behavior.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../../../../errors.ts";
import type { IAgentRuntime } from "../../../../types/index.ts";
import {
	type DeferredMessageScheduler,
	getDeferredMessageScheduler,
	registerDeferredMessageScheduler,
} from "../deferred-send-scheduler.ts";

function createRuntime(): IAgentRuntime {
	return {} as IAgentRuntime;
}

function createScheduler(): DeferredMessageScheduler {
	return {
		schedule: () => Promise.reject(new Error("not exercised by the registry")),
	};
}

describe("deferred-message scheduler registration", () => {
	it("returns null when a runtime has no registered scheduler", () => {
		expect(getDeferredMessageScheduler(createRuntime())).toBeNull();
	});

	it("registers and disposes the scheduler for a runtime", () => {
		const runtime = createRuntime();
		const scheduler = createScheduler();

		const dispose = registerDeferredMessageScheduler(runtime, scheduler);

		expect(getDeferredMessageScheduler(runtime)).toBe(scheduler);
		dispose();
		expect(getDeferredMessageScheduler(runtime)).toBeNull();
	});

	it("rejects duplicate registration without replacing the first scheduler", () => {
		const runtime = createRuntime();
		const first = createScheduler();
		const dispose = registerDeferredMessageScheduler(runtime, first);
		let duplicateError: unknown;

		try {
			registerDeferredMessageScheduler(runtime, createScheduler());
		} catch (error) {
			duplicateError = error;
		}

		expect(duplicateError).toBeInstanceOf(ElizaError);
		expect(duplicateError).toMatchObject({
			code: "DEFERRED_MESSAGE_SCHEDULER_DUPLICATE",
			severity: "fatal",
		});
		expect(getDeferredMessageScheduler(runtime)).toBe(first);
		dispose();
	});

	it("does not let a stale disposer remove a replacement scheduler", () => {
		const runtime = createRuntime();
		const firstDispose = registerDeferredMessageScheduler(
			runtime,
			createScheduler(),
		);
		firstDispose();
		const replacement = createScheduler();
		const replacementDispose = registerDeferredMessageScheduler(
			runtime,
			replacement,
		);

		firstDispose();

		expect(getDeferredMessageScheduler(runtime)).toBe(replacement);
		replacementDispose();
	});

	it("keeps registrations isolated between runtimes", () => {
		const firstRuntime = createRuntime();
		const secondRuntime = createRuntime();
		const firstScheduler = createScheduler();
		const secondScheduler = createScheduler();
		const disposeFirst = registerDeferredMessageScheduler(
			firstRuntime,
			firstScheduler,
		);
		const disposeSecond = registerDeferredMessageScheduler(
			secondRuntime,
			secondScheduler,
		);

		expect(getDeferredMessageScheduler(firstRuntime)).toBe(firstScheduler);
		expect(getDeferredMessageScheduler(secondRuntime)).toBe(secondScheduler);

		disposeFirst();
		expect(getDeferredMessageScheduler(firstRuntime)).toBeNull();
		expect(getDeferredMessageScheduler(secondRuntime)).toBe(secondScheduler);
		disposeSecond();
	});
});

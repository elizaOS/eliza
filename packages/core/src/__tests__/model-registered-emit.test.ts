/**
 * A MODEL_REGISTERED observer that rejects must not surface as an unhandled
 * rejection. `registerModel` announces the registration fire-and-forget (the
 * registry must never block boot), but `emitEvent` awaits every handler, and
 * real observers reject: the embedding service's registration handler awaits
 * `initialize()`, and the API server broadcasts. An unhandled rejection kills a
 * CLI/embedded host that installed no global handler, so the failure is reported
 * through the runtime's error channel instead.
 *
 * The cases drive the real `AgentRuntime`: a real observer registered on
 * MODEL_REGISTERED, a real `registerModel` call, and a `process`-level
 * unhandledRejection probe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime.ts";
import { EventType } from "../types/events.ts";
import { ModelType } from "../types/model.ts";

function runtime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "ModelRegisteredObserver",
			bio: ["Tests the MODEL_REGISTERED announcement path"],
		},
		logLevel: "fatal",
	});
}

/** Collects unhandled rejections raised while `run` executes. */
async function unhandledRejectionsDuring(
	run: () => Promise<void>,
): Promise<unknown[]> {
	const seen: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		seen.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		await run();
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	return seen;
}

/** Lets the fire-and-forget announcement settle. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MODEL_REGISTERED announcement", () => {
	it("reports a rejecting observer instead of leaving an unhandled rejection", async () => {
		const agent = runtime();
		const reportError = vi.spyOn(agent, "reportError");
		const observerFailure = new Error("observer failed while initializing");
		agent.registerEvent(EventType.MODEL_REGISTERED, async () => {
			throw observerFailure;
		});

		const unhandled = await unhandledRejectionsDuring(async () => {
			agent.registerModel(
				ModelType.TEXT_SMALL,
				async () => "ok",
				"test-provider",
			);
			await settle();
		});

		expect(unhandled).toHaveLength(0);
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError.mock.calls[0]?.[0]).toBe("AgentRuntime.registerModel");
		expect(reportError.mock.calls[0]?.[1]).toBe(observerFailure);
	});

	it("does not report anything when every observer resolves", async () => {
		const agent = runtime();
		const reportError = vi.spyOn(agent, "reportError");
		const observed: string[] = [];
		agent.registerEvent(EventType.MODEL_REGISTERED, async () => {
			observed.push("seen");
		});

		const unhandled = await unhandledRejectionsDuring(async () => {
			agent.registerModel(
				ModelType.TEXT_SMALL,
				async () => "ok",
				"test-provider",
			);
			await settle();
		});

		expect(unhandled).toHaveLength(0);
		expect(observed).toEqual(["seen"]);
		expect(reportError).not.toHaveBeenCalled();
	});
});

import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { emitEventObserved } from "../emit-event-observed";

function createRuntime(emitEvent: IAgentRuntime["emitEvent"]) {
	const reportError = vi.fn();
	const runtime = { emitEvent, reportError } as unknown as IAgentRuntime;
	return { runtime, reportError };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("emitEventObserved", () => {
	it("passes the event name and payload through to emitEvent", async () => {
		const emitEvent = vi.fn(async () => undefined);
		const { runtime, reportError } = createRuntime(emitEvent);
		const payload = { source: "discord" } as unknown as EventPayload;

		emitEventObserved(runtime, ["ENTITY_JOINED"], payload);
		await flushMicrotasks();

		expect(emitEvent).toHaveBeenCalledWith(["ENTITY_JOINED"], payload);
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reports a rejecting listener instead of an unhandled rejection", async () => {
		const listenerError = new Error("listener boom");
		const emitEvent = vi.fn(async () => {
			throw listenerError;
		});
		const { runtime, reportError } = createRuntime(emitEvent);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			emitEventObserved(runtime, ["ENTITY_JOINED"], {} as EventPayload);
			await flushMicrotasks();
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}

		expect(reportError).toHaveBeenCalledWith("discord:emit-event", listenerError, {
			eventName: "ENTITY_JOINED",
		});
		expect(unhandled).toHaveLength(0);
	});

	it("reports a synchronously throwing emitEvent and does not throw", async () => {
		const listenerError = new Error("sync boom");
		const emitEvent = vi.fn(() => {
			throw listenerError;
		}) as unknown as IAgentRuntime["emitEvent"];
		const { runtime, reportError } = createRuntime(emitEvent);

		expect(() =>
			emitEventObserved(runtime, "ENTITY_JOINED", {} as EventPayload),
		).not.toThrow();
		await flushMicrotasks();

		expect(reportError).toHaveBeenCalledWith("discord:emit-event", listenerError, {
			eventName: "ENTITY_JOINED",
		});
	});
});

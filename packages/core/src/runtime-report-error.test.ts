/**
 * Tests for `runtime.reportError` on a real AgentRuntime (no mock swallow):
 * it logs, records the failure in the ring, emits a typed ERROR_REPORTED
 * payload to real registered handlers, forwards to the AgentEventService error
 * stream, and stays self-safe when a handler throws or when it re-enters.
 */

import { describe, expect, it, vi } from "vitest";
import { ElizaError } from "./errors";
import { AgentRuntime } from "./runtime";
import type { Character, ErrorReportedPayload } from "./types";
import { EventType } from "./types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: { name: "report-error-test" } as Character,
	});
}

describe("AgentRuntime.reportError", () => {
	it("emits a typed ERROR_REPORTED payload derived from ElizaError", async () => {
		const runtime = makeRuntime();
		const received: ErrorReportedPayload[] = [];
		runtime.registerEvent(EventType.ERROR_REPORTED, async (payload) => {
			received.push(payload as ErrorReportedPayload);
		});

		runtime.reportError(
			"TestScope",
			new ElizaError("provider blew up", {
				code: "PROVIDER_FAILED",
				context: { provider: "recent-errors" },
			}),
			{ extra: "detail" },
		);

		// emitEvent is async fire-and-forget; let the microtask flush.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(received).toHaveLength(1);
		expect(received[0].scope).toBe("TestScope");
		expect(received[0].code).toBe("PROVIDER_FAILED");
		expect(received[0].message).toBe("provider blew up");
		expect(received[0].context).toMatchObject({
			provider: "recent-errors",
			extra: "detail",
		});
	});

	it("normalizes a non-ElizaError to code UNCLASSIFIED and records it in the ring", () => {
		const runtime = makeRuntime();
		runtime.reportError("Boot", new Error("plain failure"));

		const recent = runtime.getRecentReportedErrors();
		expect(recent).toHaveLength(1);
		expect(recent[0].code).toBe("UNCLASSIFIED");
		expect(recent[0].scope).toBe("Boot");
		expect(recent[0].message).toBe("plain failure");
		expect(typeof recent[0].at).toBe("number");
	});

	it("caps the ring and drops oldest entries", () => {
		const runtime = makeRuntime();
		for (let i = 0; i < 250; i++) {
			runtime.reportError(
				"Loop",
				new ElizaError(`err ${i}`, { code: `C${i}` }),
			);
		}
		const recent = runtime.getRecentReportedErrors();
		expect(recent.length).toBe(200);
		// Oldest (err 0..49) dropped; newest retained.
		expect(recent.at(-1)?.message).toBe("err 249");
		expect(recent.some((e) => e.message === "err 0")).toBe(false);
	});

	it("never throws even when an ERROR_REPORTED handler throws", async () => {
		const runtime = makeRuntime();
		runtime.registerEvent(EventType.ERROR_REPORTED, async () => {
			throw new Error("handler exploded");
		});
		// Must not throw synchronously.
		expect(() =>
			runtime.reportError("X", new ElizaError("y", { code: "Y" })),
		).not.toThrow();
		// The throwing handler rejects the emit; give it a tick to be swallowed.
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The failure was still recorded despite the handler throwing.
		expect(runtime.getRecentReportedErrors()).toHaveLength(1);
	});

	it("suppresses a synchronously re-entering ERROR_REPORTED handler via the inReportError latch", () => {
		const runtime = makeRuntime();
		const warnSpy = vi.spyOn(runtime.logger, "warn");

		// emitEvent invokes handlers synchronously (Array.map before its await), so
		// this handler body runs while the outer reportError is still on the stack
		// with inReportError === true. Each full report path emits ERROR_REPORTED,
		// so WITHOUT the latch the nested report would re-emit -> re-invoke this
		// handler -> re-report, recursing synchronously until the stack overflows.
		let handlerInvocations = 0;
		runtime.registerEvent(EventType.ERROR_REPORTED, async () => {
			handlerInvocations += 1;
			runtime.reportError("Nested", new ElizaError("nested", { code: "N" }));
		});

		// The latch turns the nested re-entry into a warn-only no-op; the outer
		// call returns normally instead of blowing the stack.
		expect(() =>
			runtime.reportError("Outer", new ElizaError("outer", { code: "O" })),
		).not.toThrow();

		// Handler fired exactly once: the nested reportError was short-circuited
		// before it could emit a second ERROR_REPORTED event. (Removing the latch
		// makes this grow without bound / overflow the stack.)
		expect(handlerInvocations).toBe(1);

		// Records exactly once — only the outer failure reached the ring; the
		// nested re-entry recorded nothing.
		expect(runtime.getRecentReportedErrors().map((e) => e.code)).toEqual(["O"]);

		// The latch took its documented warn-only drop path for the nested entry.
		expect(
			warnSpy.mock.calls.some(
				([, msg]) =>
					typeof msg === "string" &&
					msg.includes("re-entered while already reporting"),
			),
		).toBe(true);

		warnSpy.mockRestore();
	});

	it("forwards to the AgentEventService error stream when registered", async () => {
		const runtime = makeRuntime();
		const emitted: Array<{ stream: string; data: Record<string, unknown> }> =
			[];
		const fakeService = {
			emit: (event: { stream: string; data: Record<string, unknown> }) => {
				emitted.push(event);
			},
		};
		const original = runtime.getService.bind(runtime);
		vi.spyOn(runtime, "getService").mockImplementation((name: unknown) =>
			name === "agent_event" ? (fakeService as never) : original(name as never),
		);

		runtime.reportError(
			"Stream",
			new ElizaError("streamed", { code: "STREAMED" }),
		);

		expect(emitted).toHaveLength(1);
		expect(emitted[0].stream).toBe("error");
		expect(emitted[0].data).toMatchObject({
			code: "STREAMED",
			scope: "Stream",
			message: "streamed",
		});
	});
});

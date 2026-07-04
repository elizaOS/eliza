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

	it("is self-safe: a handler that re-enters reportError does not recurse infinitely", () => {
		const runtime = makeRuntime();
		const spy = vi.spyOn(runtime, "reportError");
		runtime.registerEvent(EventType.ERROR_REPORTED, async () => {
			// A handler that itself reports an error must be dropped (warn-only),
			// not loop back through the full report path.
			runtime.reportError("Nested", new ElizaError("nested", { code: "N" }));
		});
		runtime.reportError("Outer", new ElizaError("outer", { code: "O" }));
		// Only the outer failure is recorded in the ring; the nested re-entry is
		// dropped by the latch.
		const recent = runtime.getRecentReportedErrors();
		expect(recent.map((e) => e.code)).toEqual(["O"]);
		spy.mockRestore();
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

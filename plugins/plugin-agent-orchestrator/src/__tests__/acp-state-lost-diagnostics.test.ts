/**
 * When a mid-flight sub-agent loses its ACP state (process exited without
 * persisting), the service must emit a warn diagnostic carrying the session's
 * identity and the tail of its output buffer BEFORE the buffer is reclaimed —
 * otherwise the crash leaves no forensic trail. Exercises the real
 * `logSubAgentStateLost` path with an in-memory store and a captured logger.
 */
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { InMemorySessionStore } from "../services/session-store.ts";
import type { SessionInfo } from "../services/types.ts";

function makeRuntime(warn: (msg: string, data?: unknown) => void) {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		character: { name: "Tester" },
		getSetting: () => undefined,
		logger: { debug() {}, info() {}, warn, error() {} },
		getService: () => null,
	};
}

function session(id: string): SessionInfo {
	const now = new Date(Date.now() - 5 * 60_000);
	return {
		id,
		name: id,
		agentType: "elizaos",
		workdir: "/home/x/apps/app-thing",
		status: "running",
		approvalPreset: "standard",
		createdAt: now,
		lastActivityAt: now,
		acpxSessionId: "acpx-123",
		pid: 4242,
	} as SessionInfo;
}

describe("AcpService state-lost diagnostics", () => {
	it("logs the session identity and output tail before reclaim", async () => {
		const warn = vi.fn();
		const store = new InMemorySessionStore();
		const s = session("sess-1");
		await store.create(s);
		const svc = new AcpService(makeRuntime(warn) as never, { store });

		// Seed the session's output buffer as a live run would.
		const buffers = (svc as unknown as { outputBuffers: Map<string, string[]> })
			.outputBuffers;
		buffers.set("sess-1", [
			"installing deps\n",
			"vite build...\n",
			"FATAL: heap out of memory\n",
		]);

		(
			svc as unknown as {
				logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
			}
		).logSubAgentStateLost(s, "health-check");

		expect(warn).toHaveBeenCalledTimes(1);
		const [message, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
		expect(message).toContain("state lost");
		expect(data).toMatchObject({
			phase: "health-check",
			sessionId: "sess-1",
			acpxSessionId: "acpx-123",
			agentType: "elizaos",
			workdir: "/home/x/apps/app-thing",
			pid: 4242,
			outputLines: 3,
		});
		// The crash reason is preserved in the tail.
		expect(String(data.tailOutput)).toContain("heap out of memory");
		// Idle time is computed (~5 min).
		expect(Number(data.idleMs)).toBeGreaterThan(4 * 60_000);
	});

	it("reports no buffered output cleanly when the session produced none", async () => {
		const warn = vi.fn();
		const store = new InMemorySessionStore();
		const s = session("sess-2");
		await store.create(s);
		const svc = new AcpService(makeRuntime(warn) as never, { store });

		(
			svc as unknown as {
				logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
			}
		).logSubAgentStateLost(s, "send-prompt");

		const [, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
		expect(data.phase).toBe("send-prompt");
		expect(data.outputLines).toBe(0);
		expect(data.tailOutput).toBe("(no buffered output)");
	});
});

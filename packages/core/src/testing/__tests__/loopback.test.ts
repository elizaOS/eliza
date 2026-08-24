import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createServer: vi.fn(),
}));

vi.mock("node:net", () => ({
	default: { createServer: (...a: unknown[]) => mocks.createServer(...a) },
}));

function fakeServer() {
	const s = new EventEmitter() as EventEmitter & {
		listen: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		removeAllListeners: ReturnType<typeof vi.fn>;
	};
	s.listen = vi.fn((_port: number, _host: string, cb: () => void) => {
		process.nextTick(() => cb());
	});
	s.close = vi.fn((cb?: () => void) => {
		process.nextTick(() => cb?.());
	});
	s.removeAllListeners = vi.fn();
	return s;
}

describe("canBindLoopback", () => {
	beforeEach(() => {
		mocks.createServer.mockReset();
		vi.resetModules();
	});

	it("resolves false on server error", async () => {
		const { canBindLoopback } = await import("../loopback.ts");
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		const p = canBindLoopback();
		s.emit("error", new Error("EACCES"));
		expect(await p).toBe(false);
	});

	it("resolves true when binding succeeds", async () => {
		const { canBindLoopback } = await import("../loopback.ts");
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		expect(await canBindLoopback()).toBe(true);
	});

	it("shares one probe across concurrent callers", async () => {
		const { canBindLoopback } = await import("../loopback.ts");
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		const first = canBindLoopback();
		const second = canBindLoopback();
		expect(second).toBe(first);
		expect(mocks.createServer).toHaveBeenCalledTimes(1);
		expect(await first).toBe(true);
	});

	it("keeps returning the settled promise instead of re-probing", async () => {
		const { canBindLoopback } = await import("../loopback.ts");
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		const probe = canBindLoopback();
		expect(await probe).toBe(true);
		expect(await canBindLoopback()).toBe(true);
		expect(canBindLoopback()).toBe(probe);
		expect(mocks.createServer).toHaveBeenCalledTimes(1);
	});

	it("memoizes a failed bind instead of re-probing", async () => {
		const { canBindLoopback } = await import("../loopback.ts");
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		s.listen.mockImplementation(() => {
			process.nextTick(() => s.emit("error", new Error("EACCES")));
		});
		expect(await canBindLoopback()).toBe(false);
		expect(await canBindLoopback()).toBe(false);
		expect(mocks.createServer).toHaveBeenCalledTimes(1);
	});

	it("probes an ephemeral port on the loopback host", async () => {
		const { canBindLoopback } = await import("../loopback.ts");
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		await canBindLoopback();
		expect(s.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
	});
});

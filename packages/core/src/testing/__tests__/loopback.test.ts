import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createServer: vi.fn(),
}));

vi.mock("node:net", () => ({
	default: { createServer: (...a: unknown[]) => mocks.createServer(...a) },
}));

import { canBindLoopback } from "./loopback.ts";

function fakeServer() {
	const s = new EventEmitter() as EventEmitter & {
		listen: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		removeAllListeners: ReturnType<typeof vi.fn>;
	};
	s.listen = vi.fn((_port: number, _host: string, cb: () => void) => {
		// 模拟绑定成功后 close
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
	});

	it("resolves false on server error", async () => {
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		const p = canBindLoopback();
		s.emit("error", new Error("EACCES"));
		expect(await p).toBe(false);
	});

	it("resolves true when binding succeeds", async () => {
		const s = fakeServer();
		mocks.createServer.mockReturnValue(s);
		expect(await canBindLoopback()).toBe(true);
	});
});

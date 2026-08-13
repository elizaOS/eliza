/** Proves failed ASR smoke checks release native regions before surfacing the failure. */
import { describe, expect, it, vi } from "vitest";
import { failAsrSmoke, runAsrSmokeWithCleanup } from "./asr-smoke-lifecycle";
import type { ElizaInferenceFfi } from "./ffi-bindings";

describe("ASR smoke native cleanup", () => {
	it("evicts, destroys, and closes in order when a transcript assertion fails", () => {
		const calls: string[] = [];
		const ffi = {
			create: vi.fn(() => {
				calls.push("create");
				return 1n;
			}),
			mmapAcquire: vi.fn(() => calls.push("mmapAcquire")),
			mmapEvict: vi.fn(() => calls.push("mmapEvict")),
			destroy: vi.fn(() => calls.push("destroy")),
			close: vi.fn(() => calls.push("close")),
		} as unknown as ElizaInferenceFfi;

		expect(() =>
			runAsrSmokeWithCleanup({
				ffi,
				bundleDir: "/tmp/bundle",
				run: () => failAsrSmoke("bad transcript"),
			}),
		).toThrow("bad transcript");
		expect(calls).toEqual([
			"create",
			"mmapAcquire",
			"mmapEvict",
			"destroy",
			"close",
		]);
	});

	it("destroys and closes when acquisition fails before a region is resident", () => {
		const calls: string[] = [];
		const ffi = {
			create: vi.fn(() => {
				calls.push("create");
				return 1n;
			}),
			mmapAcquire: vi.fn(() => {
				calls.push("mmapAcquire");
				throw new Error("acquire failed");
			}),
			mmapEvict: vi.fn(() => calls.push("mmapEvict")),
			destroy: vi.fn(() => calls.push("destroy")),
			close: vi.fn(() => calls.push("close")),
		} as unknown as ElizaInferenceFfi;

		expect(() =>
			runAsrSmokeWithCleanup({
				ffi,
				bundleDir: "/tmp/bundle",
				run: () => undefined,
			}),
		).toThrow("acquire failed");
		expect(calls).toEqual(["create", "mmapAcquire", "destroy", "close"]);
	});

	it("still destroys and closes when region eviction fails", () => {
		const calls: string[] = [];
		const ffi = {
			create: vi.fn(() => {
				calls.push("create");
				return 1n;
			}),
			mmapAcquire: vi.fn(() => calls.push("mmapAcquire")),
			mmapEvict: vi.fn(() => {
				calls.push("mmapEvict");
				throw new Error("evict failed");
			}),
			destroy: vi.fn(() => calls.push("destroy")),
			close: vi.fn(() => calls.push("close")),
		} as unknown as ElizaInferenceFfi;

		expect(() =>
			runAsrSmokeWithCleanup({
				ffi,
				bundleDir: "/tmp/bundle",
				run: () => undefined,
			}),
		).toThrow("evict failed");
		expect(calls).toEqual([
			"create",
			"mmapAcquire",
			"mmapEvict",
			"destroy",
			"close",
		]);
	});
});

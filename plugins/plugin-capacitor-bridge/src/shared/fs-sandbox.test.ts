import { afterEach, describe, expect, it, vi } from "vitest";
import {
	guardMobileFsWritePath,
	mobileFsPathLikeToString,
	modeForMobileFsOpenFlags,
	requireMobileFsResolver,
	type MobileFsGlobals,
	wrapMobileFsOpen,
	wrapMobileFsPath,
	wrapMobileFsTwoPaths,
} from "./fs-sandbox.ts";

function globals(): MobileFsGlobals {
	return globalThis as MobileFsGlobals;
}

afterEach(() => {
	delete globals().__ELIZA_MOBILE_FS_RESOLVE__;
});

describe("mobile fs sandbox wrappers", () => {
	it("requires the mobile fs resolver before path operations can run", () => {
		expect(() => requireMobileFsResolver("node:fs")).toThrow(
			"node:fs: filesystem access before installMobileFsShim()",
		);

		const wrapped = wrapMobileFsPath("node:fs", vi.fn(), "read");
		expect(() => wrapped("notes.txt")).toThrow(
			"node:fs: filesystem access before installMobileFsShim()",
		);
	});

	it("normalizes path-like strings, Buffers, and file URLs", () => {
		expect(mobileFsPathLikeToString("notes.txt", "node:fs")).toBe(
			"notes.txt",
		);
		expect(
			mobileFsPathLikeToString(Buffer.from("buffer.txt"), "node:fs"),
		).toBe("buffer.txt");
		expect(
			mobileFsPathLikeToString(new URL("file:///tmp/mobile.txt"), "node:fs"),
		).toBe("/tmp/mobile.txt");
		expect(mobileFsPathLikeToString(123, "node:fs")).toBeNull();
		expect(() =>
			mobileFsPathLikeToString(new URL("https://example.com/file"), "node:fs"),
		).toThrow("node:fs: only file: URLs are accepted (https:)");
	});

	it("resolves first path arguments with the requested access mode", () => {
		const resolver = vi.fn((input: string, mode = "read") => {
			return `/sandbox/${mode}/${input}`;
		});
		globals().__ELIZA_MOBILE_FS_RESOLVE__ = resolver;
		const original = vi.fn((path: string, encoding: string) => ({
			path,
			encoding,
		}));

		const wrapped = wrapMobileFsPath("node:fs", original, "write");
		expect(wrapped("out.txt", "utf8")).toEqual({
			path: "/sandbox/write/out.txt",
			encoding: "utf8",
		});
		expect(resolver).toHaveBeenCalledWith("out.txt", "write");
		expect(original).toHaveBeenCalledWith("/sandbox/write/out.txt", "utf8");
	});

	it("blocks writes to native binary extensions after resolver normalization", () => {
		const resolver = vi.fn((input: string, mode = "read") => {
			return `/sandbox/${mode}/${input}`;
		});
		globals().__ELIZA_MOBILE_FS_RESOLVE__ = resolver;
		const original = vi.fn();
		const wrapped = wrapMobileFsPath("node:fs", original, "write");

		expect(() => wrapped("addon.node")).toThrow(
			"mobile-fs-shim: writing native binary files is blocked (.node)",
		);
		expect(() => wrapped("libnative.so")).toThrow(
			"mobile-fs-shim: writing native binary files is blocked (.so)",
		);
		expect(() => guardMobileFsWritePath("/sandbox/lib.dylib", "lib.dylib"))
			.toThrow("mobile-fs-shim: writing native binary files is blocked (.dylib)");
		expect(original).not.toHaveBeenCalled();
	});

	it("derives open mode from string and numeric flags", () => {
		expect(modeForMobileFsOpenFlags("r")).toBe("read");
		expect(modeForMobileFsOpenFlags("rs")).toBe("read");
		expect(modeForMobileFsOpenFlags("a")).toBe("write");
		expect(modeForMobileFsOpenFlags("w+")).toBe("write");
		expect(modeForMobileFsOpenFlags(0)).toBe("read");
		expect(modeForMobileFsOpenFlags(1)).toBe("write");
		expect(modeForMobileFsOpenFlags(undefined)).toBe("read");
	});

	it("resolves open calls using the access mode implied by flags", () => {
		const resolver = vi.fn((input: string, mode = "read") => {
			return `/sandbox/${mode}/${input}`;
		});
		globals().__ELIZA_MOBILE_FS_RESOLVE__ = resolver;
		const original = vi.fn((path: string, flags: string) => `${flags}:${path}`);
		const wrapped = wrapMobileFsOpen("node:fs", original);

		expect(wrapped("read.txt", "r")).toBe("r:/sandbox/read/read.txt");
		expect(wrapped("write.txt", "w")).toBe("w:/sandbox/write/write.txt");
		expect(resolver).toHaveBeenNthCalledWith(1, "read.txt", "read");
		expect(resolver).toHaveBeenNthCalledWith(2, "write.txt", "write");
	});

	it("resolves two-path operations independently", () => {
		const resolver = vi.fn((input: string, mode = "read") => {
			return `/sandbox/${mode}/${input}`;
		});
		globals().__ELIZA_MOBILE_FS_RESOLVE__ = resolver;
		const original = vi.fn((src: string, dst: string) => ({ src, dst }));
		const wrapped = wrapMobileFsTwoPaths(
			"node:fs",
			original,
			"read",
			"write",
		);

		expect(wrapped("from.txt", Buffer.from("to.txt"))).toEqual({
			src: "/sandbox/read/from.txt",
			dst: "/sandbox/write/to.txt",
		});
		expect(resolver).toHaveBeenNthCalledWith(1, "from.txt", "read");
		expect(resolver).toHaveBeenNthCalledWith(2, "to.txt", "write");
	});
});

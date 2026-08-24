/**
 * Tests for device-filesystem path sanitisation.
 *
 * Materiality: every relative path from a caller passes through
 * `normalizeDevicePath` before either backend touches it. Accepting an
 * absolute path, a `..` segment, or a NUL byte here would let a caller read
 * or write outside the backend root (path traversal on the device bridge).
 * The `.`-segment post-normalize check is defense-in-depth: a path that
 * collapses to the root must be rejected unless explicitly allowed.
 */
import { describe, expect, it } from "vitest";
import { normalizeDevicePath } from "./path";

describe("normalizeDevicePath", () => {
	it("rejects empty paths unless allowRoot is set", () => {
		expect(() => normalizeDevicePath("")).toThrow(/path is required/);
		expect(normalizeDevicePath("", { allowRoot: true })).toEqual({
			relative: "",
			segments: [],
		});
	});

	it("rejects non-string inputs", () => {
		expect(() => normalizeDevicePath(null as unknown as string)).toThrow(
			/path is required/,
		);
		expect(() => normalizeDevicePath(42 as unknown as string)).toThrow(
			/path is required/,
		);
	});

	it("rejects NUL bytes", () => {
		expect(() => normalizeDevicePath("a\0b")).toThrow(/NUL byte/);
	});

	it("rejects absolute POSIX paths", () => {
		expect(() => normalizeDevicePath("/etc/passwd")).toThrow(
			/absolute paths are not allowed/,
		);
		expect(() => normalizeDevicePath("/")).toThrow(
			/absolute paths are not allowed/,
		);
	});

	it("rejects absolute Windows paths in both separator styles", () => {
		expect(() => normalizeDevicePath("C:/Users/x")).toThrow(
			/absolute paths are not allowed/,
		);
		expect(() => normalizeDevicePath("C:\\Users\\x")).toThrow(
			/absolute paths are not allowed/,
		);
	});

	it("rejects `..` traversal segments anywhere in the path", () => {
		for (const hostile of ["..", "../x", "a/../b", "a/../../b", "a/.."]) {
			expect(() => normalizeDevicePath(hostile)).toThrow(
				/path traversal is not allowed/,
			);
		}
	});

	it("rejects paths that normalize to the root", () => {
		expect(() => normalizeDevicePath("a/..", { allowRoot: true })).toThrow(
			/path traversal is not allowed/,
		);
	});

	it("normalizes separators and redundant slashes", () => {
		expect(normalizeDevicePath("a\\b//c/")).toEqual({
			relative: "a/b/c",
			segments: ["a", "b", "c"],
		});
	});

	it("collapses interior dot segments to the canonical form", () => {
		expect(normalizeDevicePath("a/./b")).toEqual({
			relative: "a/b",
			segments: ["a", "b"],
		});
	});

	it("preserves dot-prefixed segments (hidden files) as data", () => {
		expect(normalizeDevicePath(".hidden/file")).toEqual({
			relative: ".hidden/file",
			segments: [".hidden", "file"],
		});
	});

	it("allows the root explicitly via allowRoot", () => {
		expect(normalizeDevicePath(".", { allowRoot: true })).toEqual({
			relative: "",
			segments: [],
		});
		expect(normalizeDevicePath("", { allowRoot: true })).toEqual({
			relative: "",
			segments: [],
		});
	});
});

import { describe, expect, it } from "vitest";
import { isSafeExecutableValue } from "../src/utils/exec-safety";

describe("isSafeExecutableValue", () => {
	it("rejects a command whose argument is a path", () => {
		expect(isSafeExecutableValue("/usr/bin/foo bar/baz")).toBe(false);
		expect(isSafeExecutableValue("./run.sh arg/with/slash")).toBe(false);
		expect(isSafeExecutableValue("/bin/ls foo/bar")).toBe(false);
		expect(isSafeExecutableValue("foo/bar baz/qux")).toBe(false);
		expect(isSafeExecutableValue("C:\\tools\\foo.exe bar\\baz")).toBe(false);
	});

	it("still rejects bare-name and dash arguments", () => {
		expect(isSafeExecutableValue("/usr/bin/foo --flag")).toBe(false);
		expect(isSafeExecutableValue("/usr/bin/foo bar")).toBe(false);
		expect(isSafeExecutableValue("foo bar")).toBe(false);
	});

	it("still accepts a plain bare name or path with no arguments", () => {
		expect(isSafeExecutableValue("/usr/bin/foo")).toBe(true);
		expect(isSafeExecutableValue("./run.sh")).toBe(true);
		expect(isSafeExecutableValue("foo")).toBe(true);
		expect(isSafeExecutableValue("my-tool")).toBe(true);
		expect(isSafeExecutableValue("~/bin/tool")).toBe(true);
		expect(isSafeExecutableValue("C:\\tools\\foo.exe")).toBe(true);
	});

	it("still rejects shell syntax, empty values, and option-like values", () => {
		expect(isSafeExecutableValue("foo;bar")).toBe(false);
		expect(isSafeExecutableValue("foo|bar")).toBe(false);
		expect(isSafeExecutableValue("")).toBe(false);
		expect(isSafeExecutableValue("   ")).toBe(false);
		expect(isSafeExecutableValue("-foo")).toBe(false);
		expect(isSafeExecutableValue(42)).toBe(false);
	});
});

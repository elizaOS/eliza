/** A log prefix is one bracketed token on one line. The name comes from the
 * environment or argv, so a newline in it would split one log call across
 * lines, a `]` would forge a second tag, and a control character would ride
 * an escape sequence into the logs. Such a name is sanitized to a single
 * safe token instead. The prefix is cached per module, so each test imports
 * a fresh module. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshPrefix(): Promise<string> {
	vi.resetModules();
	const mod = await import("../src/utils/log-prefix");
	return mod.getLogPrefix();
}

describe("getLogPrefix name sanitization", () => {
	const originalEnv = { ...process.env };
	const originalArgv = [...process.argv];

	beforeEach(() => {
		vi.resetModules();
		delete process.env.APP_CLI_NAME;
		delete process.env.npm_package_name;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		process.argv = [...originalArgv];
		vi.resetModules();
	});

	it("strips a newline and brackets from APP_CLI_NAME", async () => {
		process.env.APP_CLI_NAME = "evil]\n[forged";
		expect(await freshPrefix()).toBe("[evilforged]");
	});

	it("strips brackets from APP_CLI_NAME", async () => {
		process.env.APP_CLI_NAME = "my]app";
		expect(await freshPrefix()).toBe("[myapp]");
	});

	it("strips an ANSI escape from APP_CLI_NAME", async () => {
		process.env.APP_CLI_NAME = "\u001b[31mred";
		expect(await freshPrefix()).toBe("[31mred]");
	});

	it("falls through to the package name when APP_CLI_NAME sanitizes to empty", async () => {
		process.env.APP_CLI_NAME = "[]";
		process.env.npm_package_name = "mypkg";
		expect(await freshPrefix()).toBe("[mypkg]");
	});

	it("strips brackets from the package name", async () => {
		process.env.npm_package_name = "@scope/my]pkg";
		expect(await freshPrefix()).toBe("[mypkg]");
	});

	it("strips a newline from a --name= argument", async () => {
		process.argv = [...process.argv, "--name=a\nb"];
		expect(await freshPrefix()).toBe("[ab]");
	});

	it("keeps a plain name unchanged", async () => {
		process.env.APP_CLI_NAME = "myapp";
		expect(await freshPrefix()).toBe("[myapp]");
	});
});

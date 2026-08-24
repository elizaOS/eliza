import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPath } from "./paths.ts";

describe("resolveConfigPath", () => {
	const stateDir = "/home/test/.local/state/eliza";

	it("defaults to eliza.json under the state dir", () => {
		expect(resolveConfigPath({}, stateDir)).toBe(
			path.join(stateDir, "eliza.json"),
		);
	});

	it("ignores a blank ELIZA_CONFIG_PATH override", () => {
		expect(resolveConfigPath({ ELIZA_CONFIG_PATH: "" }, stateDir)).toBe(
			path.join(stateDir, "eliza.json"),
		);
		expect(resolveConfigPath({ ELIZA_CONFIG_PATH: "   " }, stateDir)).toBe(
			path.join(stateDir, "eliza.json"),
		);
	});

	it("resolves an absolute override verbatim", () => {
		expect(
			resolveConfigPath(
				{ ELIZA_CONFIG_PATH: "/etc/eliza/custom.json" },
				stateDir,
			),
		).toBe("/etc/eliza/custom.json");
	});

	it("expands a tilde override to the home directory", () => {
		const out = resolveConfigPath(
			{ ELIZA_CONFIG_PATH: "~/eliza.json" },
			stateDir,
		);
		expect(path.isAbsolute(out)).toBe(true);
		expect(out).toBe(path.join(process.env.HOME ?? "/root", "eliza.json"));
	});

	it("resolves a relative override against cwd", () => {
		const out = resolveConfigPath(
			{ ELIZA_CONFIG_PATH: "config.json" },
			stateDir,
		);
		expect(path.isAbsolute(out)).toBe(true);
		expect(out).toBe(path.resolve("config.json"));
	});
});

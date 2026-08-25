import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	join: vi.fn((...parts: string[]) => parts.join("/")),
	getElizaNamespace: vi.fn(() => "eliza"),
	resolveStateDir: vi.fn(() => "/state"),
	resolveUserPath: vi.fn((p: string) => `/user/${p}`),
}));

vi.mock("node:fs", () => ({
	default: { existsSync: mocks.existsSync },
	existsSync: mocks.existsSync,
}));
vi.mock("node:path", () => ({ join: mocks.join, default: { join: mocks.join } }));
vi.mock("@elizaos/core", () => ({
	getElizaNamespace: mocks.getElizaNamespace,
	resolveStateDir: mocks.resolveStateDir,
	resolveUserPath: mocks.resolveUserPath,
}));

import { resolveConfigPath } from "./state-paths";

describe("resolveConfigPath", () => {
	beforeEach(() => {
		mocks.existsSync.mockReset().mockReturnValue(false);
		mocks.getElizaNamespace.mockReset().mockReturnValue("eliza");
		mocks.resolveUserPath.mockReset().mockImplementation(
			(p: string) => `/user/${p}`,
		);
	});

	it("uses the ELIZA_CONFIG_PATH override when set", () => {
		expect(resolveConfigPath({ ELIZA_CONFIG_PATH: "/custom/config.json" })).toBe(
			"/user//custom/config.json",
		);
		expect(mocks.resolveUserPath).toHaveBeenCalledWith("/custom/config.json");
	});

	it("trims the ELIZA_CONFIG_PATH override", () => {
		expect(
			resolveConfigPath({ ELIZA_CONFIG_PATH: "  /trimmed/config.json  " }),
		).toBe("/user//trimmed/config.json");
		expect(mocks.resolveUserPath).toHaveBeenCalledWith("/trimmed/config.json");
	});

	it("treats a blank override as absent and uses the primary path", () => {
		mocks.existsSync.mockReturnValue(false);
		const result = resolveConfigPath({ ELIZA_CONFIG_PATH: "   " });
		expect(result).toBe("/state/eliza.json");
	});

	it("returns the primary namespaced path when it exists", () => {
		mocks.existsSync.mockReturnValue(true);
		expect(resolveConfigPath({})).toBe("/state/eliza.json");
	});

	it("falls back to the legacy eliza.json when the namespace differs", () => {
		mocks.getElizaNamespace.mockReturnValue("myapp");
		mocks.existsSync.mockImplementation((p: string) => p === "/state/eliza.json");
		expect(resolveConfigPath({})).toBe("/state/eliza.json");
	});

	it("does not consult legacy eliza.json for the default namespace", () => {
		mocks.existsSync.mockReturnValue(false);
		expect(resolveConfigPath({})).toBe("/state/eliza.json");
		// eliza.json was never probed for the default namespace
		expect(mocks.existsSync).toHaveBeenCalledTimes(1);
	});

	it("returns the primary path when neither file exists", () => {
		expect(resolveConfigPath({})).toBe("/state/eliza.json");
	});

	it("defaults the state dir to resolveStateDir(env)", () => {
		mocks.resolveStateDir.mockReturnValue("/derived");
		mocks.existsSync.mockReturnValue(false);
		expect(resolveConfigPath({ FOO: "bar" })).toBe("/derived/eliza.json");
		expect(mocks.resolveStateDir).toHaveBeenCalledWith({ FOO: "bar" });
	});
});

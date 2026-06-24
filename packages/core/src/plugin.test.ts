import { afterEach, describe, expect, it, vi } from "vitest";
import { tryInstallPlugin } from "./plugin";

const ENV_KEYS = [
	"CI",
	"ELIZA_NO_AUTO_INSTALL",
	"ELIZA_NO_PLUGIN_AUTO_INSTALL",
	"ELIZA_TEST_MODE",
	"NODE_ENV",
] as const;

type BunStub = {
	spawn: ReturnType<typeof vi.fn>;
};

const originalEnv = new Map(
	ENV_KEYS.map((key) => [key, process.env[key]] as const),
);
const originalBun = (globalThis as { Bun?: unknown }).Bun;

function restoreEnvironment(): void {
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	if (originalBun === undefined) {
		delete (globalThis as { Bun?: unknown }).Bun;
	} else {
		(globalThis as { Bun?: unknown }).Bun = originalBun;
	}
}

function allowAutoInstallForTest(spawn: BunStub["spawn"]): void {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
	process.env.NODE_ENV = "development";
	(globalThis as { Bun?: BunStub }).Bun = { spawn };
}

describe("tryInstallPlugin", () => {
	afterEach(() => {
		restoreEnvironment();
		vi.restoreAllMocks();
	});

	it("honors the legacy plugin auto-install opt-out alias", async () => {
		const spawn = vi.fn(() => ({ exited: Promise.resolve(1) }));
		allowAutoInstallForTest(spawn);
		process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL = "true";

		await expect(
			tryInstallPlugin("@elizaos/plugin-auto-install-disabled-test"),
		).resolves.toBe(false);

		expect(spawn).not.toHaveBeenCalled();
	});

	it("reaches Bun when no auto-install opt-out env is set", async () => {
		const spawn = vi.fn(() => ({ exited: Promise.resolve(1) }));
		allowAutoInstallForTest(spawn);

		await expect(
			tryInstallPlugin("@elizaos/plugin-auto-install-allowed-test"),
		).resolves.toBe(false);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith(["bun", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
	});
});

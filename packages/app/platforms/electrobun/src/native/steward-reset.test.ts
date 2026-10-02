import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/app", async () => {
	// Real data-dir resolution; only the process lifecycle is faked.
	const actual = await vi.importActual<
		typeof import("../../../../src/services/steward-sidecar")
	>("../../../../src/services/steward-sidecar");
	return {
		resolveDesktopStewardStateRoot: actual.resolveDesktopStewardStateRoot,
		createDesktopStewardSidecar: (
			overrides?: Parameters<typeof actual.createDesktopStewardSidecar>[0],
		) => {
			const real = actual.createDesktopStewardSidecar(overrides);
			const status = real.getStatus();
			return {
				getStatus: () => status,
				start: async () => status,
				stop: async () => {},
				getCredentials: () => null,
				getApiBase: () => real.getApiBase(),
				getDataDir: () => real.getDataDir(),
			};
		},
	};
});

const ENV_KEYS = [
	"HOME",
	"XDG_STATE_HOME",
	"ELIZA_STATE_DIR",
	"ELIZA_NAMESPACE",
	"STEWARD_DATA_DIR",
] as const;

// Successful resets load the real sidecar module graph before exercising the
// filesystem operation; cold imports can exceed Vitest's five-second default.
const RESET_TIMEOUT_MS = 60_000;

describe("resetSteward", () => {
	let root: string;
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	let resetSteward: typeof import("./steward").resetSteward;

	beforeEach(async () => {
		// steward.ts caches the sidecar; load a fresh copy so each case resolves
		// the data dir from its own environment.
		vi.resetModules();
		({ resetSteward } = await import("./steward"));
		root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-reset-"));
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.HOME = path.join(root, "home");
		process.env.XDG_STATE_HOME = path.join(root, "state");
		process.env.ELIZA_NAMESPACE = "acme";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	function seedStewardData(dir: string): string {
		fs.mkdirSync(path.join(dir, "data"), { recursive: true });
		const credentials = path.join(dir, "credentials.json");
		fs.writeFileSync(credentials, "{}");
		return credentials;
	}

	it(
		"wipes the steward data under the state dir the sidecar writes to",
		async () => {
			const dataDir = path.join(root, "state", "acme", "steward");
			const credentials = seedStewardData(dataDir);

			await resetSteward();

			expect(fs.existsSync(credentials)).toBe(false);
			expect(fs.existsSync(dataDir)).toBe(false);
		},
		RESET_TIMEOUT_MS,
	);

	it(
		"accepts STEWARD_DATA_DIR pointing at the real state location",
		async () => {
			const dataDir = path.join(root, "state", "acme", "steward");
			seedStewardData(dataDir);
			process.env.STEWARD_DATA_DIR = dataDir;

			await resetSteward();

			expect(fs.existsSync(dataDir)).toBe(false);
		},
		RESET_TIMEOUT_MS,
	);

	it(
		"deletes the sidecar dir, not ELIZA_STATE_DIR/steward, when ELIZA_STATE_DIR is set",
		async () => {
			const sidecarDir = path.join(root, "state", "acme", "steward");
			const sidecarCredentials = seedStewardData(sidecarDir);
			const stateDirSteward = path.join(root, "custom-state", "steward");
			const unrelated = seedStewardData(stateDirSteward);
			process.env.ELIZA_STATE_DIR = path.join(root, "custom-state");

			await resetSteward();

			expect(fs.existsSync(sidecarCredentials)).toBe(false);
			expect(fs.existsSync(unrelated)).toBe(true);
		},
		RESET_TIMEOUT_MS,
	);

	it("refuses to delete a directory that holds no steward data", async () => {
		const notSteward = path.join(root, "state", "acme", "projects");
		fs.mkdirSync(notSteward, { recursive: true });
		const keep = path.join(notSteward, "notes.txt");
		fs.writeFileSync(keep, "keep");
		process.env.STEWARD_DATA_DIR = notSteward;

		await expect(resetSteward()).rejects.toThrow(
			/does not contain steward data/,
		);
		expect(fs.existsSync(keep)).toBe(true);
	});

	it("refuses a STEWARD_DATA_DIR outside the state roots even if it holds steward data", async () => {
		const outside = path.join(root, "elsewhere");
		const credentials = seedStewardData(outside);
		process.env.STEWARD_DATA_DIR = outside;

		await expect(resetSteward()).rejects.toThrow(/outside/);
		expect(fs.existsSync(credentials)).toBe(true);
	});

	it(
		"refuses deletion through a symlinked ancestor outside the state roots",
		async () => {
			const outside = path.join(root, "unrelated");
			const credentials = seedStewardData(path.join(outside, "steward"));
			const stateRoot = path.join(root, "state", "acme");
			fs.mkdirSync(stateRoot, { recursive: true });
			const alias = path.join(stateRoot, "alias");
			fs.symlinkSync(outside, alias, "dir");
			process.env.STEWARD_DATA_DIR = path.join(alias, "steward");

			await expect(resetSteward()).rejects.toThrow(/outside|symlink/);
			expect(fs.existsSync(credentials)).toBe(true);
		},
		RESET_TIMEOUT_MS,
	);

	it("refuses to delete the state root itself", async () => {
		const stateRoot = path.join(root, "state", "acme");
		const credentials = seedStewardData(stateRoot);
		process.env.STEWARD_DATA_DIR = stateRoot;

		await expect(resetSteward()).rejects.toThrow(/outside/);
		expect(fs.existsSync(credentials)).toBe(true);
	});
});

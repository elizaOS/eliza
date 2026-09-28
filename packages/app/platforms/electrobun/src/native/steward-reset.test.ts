import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSteward } from "./steward";

vi.mock("@elizaos/app", () => ({
	createDesktopStewardSidecar: () => {
		const status = {
			state: "stopped",
			port: null,
			pid: null,
			error: null,
			restartCount: 0,
			walletAddress: null,
			agentId: null,
			tenantId: null,
			startedAt: null,
		};
		return {
			getStatus: () => status,
			start: async () => status,
			stop: async () => {},
			getCredentials: () => null,
			getApiBase: () => "http://127.0.0.1:3200",
		};
	},
}));

const ENV_KEYS = [
	"HOME",
	"XDG_STATE_HOME",
	"ELIZA_STATE_DIR",
	"ELIZA_NAMESPACE",
	"STEWARD_DATA_DIR",
] as const;

describe("resetSteward", () => {
	let root: string;
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(() => {
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

	it("wipes the steward data under the state dir the sidecar writes to", async () => {
		const dataDir = path.join(root, "state", "acme", "steward");
		const credentials = seedStewardData(dataDir);

		await resetSteward();

		expect(fs.existsSync(credentials)).toBe(false);
		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it("accepts STEWARD_DATA_DIR pointing at the real state location", async () => {
		const dataDir = path.join(root, "state", "acme", "steward");
		seedStewardData(dataDir);
		process.env.STEWARD_DATA_DIR = dataDir;

		await resetSteward();

		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it("refuses to delete a STEWARD_DATA_DIR outside the state dir", async () => {
		const outside = path.join(root, "elsewhere");
		const credentials = seedStewardData(outside);
		process.env.STEWARD_DATA_DIR = outside;

		await expect(resetSteward()).rejects.toThrow(/Refusing to delete/);
		expect(fs.existsSync(credentials)).toBe(true);
	});
});

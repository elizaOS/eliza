/**
 * Proves the live-provider on-disk cloud-key resolution reads ELIZA_NAMESPACE and
 * ELIZA_CONFIG_PATH through the alias-aware reader (#13422), so a non-eliza brand
 * prefix (MILADY_*) resolves, the canonical ELIZA_* key wins, a blank canonical
 * value is treated as unset, and the reader never mirror-writes an ELIZA_* key.
 * Deterministic: drives the real selectLiveProvider() cloud branch against a
 * temp config file, mutating and restoring process.env / the boot-config alias
 * table / HOME around each case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekAmbientSingleton, setAmbientSingleton } from "../ambient-context";

const BOOT_CONFIG_KEY = Symbol.for("elizaos.app.boot-config");
const MILADY_ALIASES = [
	["MILADY_NAMESPACE", "ELIZA_NAMESPACE"],
	["MILADY_CONFIG_PATH", "ELIZA_CONFIG_PATH"],
	["MILADY_STATE_DIR", "ELIZA_STATE_DIR"],
] as const;

// Any of these routes selectLiveProvider away from the on-disk cloud-key branch;
// clearing them makes the alias-resolved config path the ONLY key source.
const CLEARED_KEYS = [
	"GROQ_API_KEY",
	"OPENAI_API_KEY",
	"CEREBRAS_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GOOGLE_API_KEY",
	"OPENROUTER_API_KEY",
	"ELIZAOS_CLOUD_API_KEY",
	"ELIZA_CLOUD_API_KEY",
	"ELIZA_CHAT_VIA_CLI",
	"MILADY_NAMESPACE",
	"MILADY_CONFIG_PATH",
	"MILADY_STATE_DIR",
	"ELIZA_NAMESPACE",
	"ELIZA_CONFIG_PATH",
	"ELIZA_STATE_DIR",
];

const saved = new Map<string, string | undefined>();
let priorBootConfig: unknown;
let tmpDir: string;

function writeConfig(file: string, apiKey: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ cloud: { apiKey } }), "utf8");
}

// A fresh module instance per case resets live-provider's module-level cloud-key
// cache (getConfiguredCloudApiKey memoizes on first read), so each case observes
// its own env/alias/file setup.
async function freshSelectLiveProvider() {
	vi.resetModules();
	const mod = await import("./live-provider");
	return mod.selectLiveProvider;
}

describe("live-provider alias-aware config resolution (#13422)", () => {
	beforeEach(() => {
		for (const key of [...CLEARED_KEYS, "HOME"]) {
			saved.set(key, process.env[key]);
		}
		for (const key of CLEARED_KEYS) delete process.env[key];
		priorBootConfig = peekAmbientSingleton(BOOT_CONFIG_KEY);
		setAmbientSingleton(BOOT_CONFIG_KEY, {
			current: { envAliases: MILADY_ALIASES },
		});
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-provider-alias-"));
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
		setAmbientSingleton(BOOT_CONFIG_KEY, priorBootConfig);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves MILADY_NAMESPACE via the reader to derive the config path", async () => {
		// No CONFIG_PATH set: the path is derived from the namespace, so this
		// exercises resolveAliasedEnvValue("ELIZA_NAMESPACE") picking up MILADY_.
		process.env.HOME = tmpDir;
		process.env.MILADY_NAMESPACE = "miladytest";
		writeConfig(
			path.join(tmpDir, ".miladytest", "miladytest.json"),
			"milady-ns-key",
		);

		const selectLiveProvider = await freshSelectLiveProvider();
		const provider = selectLiveProvider();

		expect(provider?.name).toBe("openai");
		expect(provider?.apiKey).toBe("milady-ns-key");
		expect(provider?.baseUrl).toContain("elizacloud.ai");
		// Additive read only — no ELIZA_* mirror written.
		expect(process.env.ELIZA_NAMESPACE).toBeUndefined();
	});

	it("resolves MILADY_CONFIG_PATH via the reader (explicit path)", async () => {
		const file = path.join(tmpDir, "milady.json");
		writeConfig(file, "milady-path-key");
		process.env.MILADY_CONFIG_PATH = file;

		const selectLiveProvider = await freshSelectLiveProvider();
		const provider = selectLiveProvider();

		expect(provider?.apiKey).toBe("milady-path-key");
		expect(process.env.ELIZA_CONFIG_PATH).toBeUndefined();
	});

	it("prefers the canonical ELIZA_CONFIG_PATH over the MILADY_ alias", async () => {
		const elizaFile = path.join(tmpDir, "eliza.json");
		const miladyFile = path.join(tmpDir, "milady.json");
		writeConfig(elizaFile, "eliza-key");
		writeConfig(miladyFile, "milady-key");
		process.env.ELIZA_CONFIG_PATH = elizaFile;
		process.env.MILADY_CONFIG_PATH = miladyFile;

		const selectLiveProvider = await freshSelectLiveProvider();
		const provider = selectLiveProvider();

		expect(provider?.apiKey).toBe("eliza-key");
	});

	it("treats a blank canonical ELIZA_CONFIG_PATH as unset and falls through to MILADY_", async () => {
		const miladyFile = path.join(tmpDir, "milady.json");
		writeConfig(miladyFile, "milady-key");
		process.env.ELIZA_CONFIG_PATH = "   ";
		process.env.MILADY_CONFIG_PATH = miladyFile;

		const selectLiveProvider = await freshSelectLiveProvider();
		const provider = selectLiveProvider();

		expect(provider?.apiKey).toBe("milady-key");
	});

	it("does not mirror-write ELIZA_* keys while resolving MILADY_ aliases", async () => {
		const file = path.join(tmpDir, "milady.json");
		writeConfig(file, "milady-key");
		process.env.MILADY_NAMESPACE = "miladytest";
		process.env.MILADY_CONFIG_PATH = file;
		const before = { ...process.env };

		const selectLiveProvider = await freshSelectLiveProvider();
		selectLiveProvider();

		expect(process.env.ELIZA_NAMESPACE).toBeUndefined();
		expect(process.env.ELIZA_CONFIG_PATH).toBeUndefined();
		expect(process.env).toEqual(before);
	});
});

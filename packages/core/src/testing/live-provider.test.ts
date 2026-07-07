/**
 * Unit tests for the live LLM provider selector, focused on the
 * CLI-subscription provider ("cli"): available when ELIZA_CHAT_VIA_CLI names a
 * valid backend AND that backend's own on-disk credentials file exists.
 *
 * The credentials path is resolved through os.homedir(), which honors $HOME on
 * POSIX — every test points HOME at a temp directory so nothing here ever
 * depends on the real ~/.claude or ~/.codex.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	availableProviderNames,
	CLI_SUBSCRIPTION_SENTINEL_API_KEY,
	selectLiveProvider,
} from "./live-provider";

const PROVIDER_ENV_VARS = [
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
	"ELIZA_PLANNER_NATIVE_TOOLS",
	"ELIZA_CLI_CLAUDE_MODEL",
	"ELIZA_CLI_CLAUDE_PLANNER_MODEL",
	"ELIZA_CLI_CLAUDE_BIN",
	"ELIZA_CLI_SDK_RESTART_AFTER_TURNS",
	"ELIZA_CLI_CODEX_MODEL",
	"ELIZA_CLI_CODEX_PLANNER_MODEL",
	"ELIZA_CLI_CODEX_REASONING_EFFORT",
	"ELIZA_CLI_CODEX_BIN",
	"ELIZA_CLI_TIMEOUT_MS",
	"OPENAI_SMALL_MODEL",
	"OPENAI_LARGE_MODEL",
	"GROQ_SMALL_MODEL",
	"GROQ_LARGE_MODEL",
	"SMALL_MODEL",
	"LARGE_MODEL",
] as const;

const savedEnv = new Map<string, string | undefined>();
let tempHome: string;

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

function writeClaudeCredentials(home: string): void {
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", ".credentials.json"),
		JSON.stringify({ claudeAiOauth: { accessToken: "test-not-real" } }),
		"utf8",
	);
}

function writeCodexCredentials(home: string): void {
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".codex", "auth.json"),
		JSON.stringify({ tokens: { access_token: "test-not-real" } }),
		"utf8",
	);
}

beforeAll(() => {
	for (const name of [
		...PROVIDER_ENV_VARS,
		"HOME",
		"USERPROFILE",
		"ELIZA_CONFIG_PATH",
	]) {
		savedEnv.set(name, process.env[name]);
	}
	// Keep the module-level cloud-config cache away from the real user config:
	// the first call in this file populates it from this nonexistent path.
	process.env.ELIZA_CONFIG_PATH = path.join(
		os.tmpdir(),
		"live-provider-test-nonexistent",
		"eliza.json",
	);
});

afterAll(() => {
	for (const [name, value] of savedEnv) {
		setEnv(name, value);
	}
});

afterEach(() => {
	if (tempHome) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
});

function resetEnv(): void {
	for (const name of PROVIDER_ENV_VARS) {
		delete process.env[name];
	}
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "live-provider-test-"));
	// os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows — set both
	// so the redirect works on every CI platform.
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
}

describe("cli live provider", () => {
	it("is unavailable when ELIZA_CHAT_VIA_CLI is unset", () => {
		resetEnv();
		writeClaudeCredentials(tempHome);
		expect(availableProviderNames()).toEqual([]);
		expect(selectLiveProvider()).toBeNull();
	});

	it("is unavailable when ELIZA_CHAT_VIA_CLI names an unknown backend", () => {
		resetEnv();
		writeClaudeCredentials(tempHome);
		process.env.ELIZA_CHAT_VIA_CLI = "gemini-cli";
		expect(availableProviderNames()).toEqual([]);
		expect(selectLiveProvider()).toBeNull();
	});

	it("is unavailable when the claude credentials file is missing", () => {
		resetEnv();
		process.env.ELIZA_CHAT_VIA_CLI = "claude";
		expect(availableProviderNames()).toEqual([]);
		expect(selectLiveProvider()).toBeNull();
	});

	it("selects the cli provider when backend + claude credentials exist", () => {
		resetEnv();
		writeClaudeCredentials(tempHome);
		process.env.ELIZA_CHAT_VIA_CLI = "claude";
		process.env.ELIZA_PLANNER_NATIVE_TOOLS = "0";

		expect(availableProviderNames()).toEqual(["cli"]);
		const provider = selectLiveProvider();
		expect(provider).not.toBeNull();
		expect(provider?.name).toBe("cli");
		expect(provider?.pluginPackage).toBe("@elizaos/plugin-cli-inference");
		expect(provider?.apiKey).toBe(CLI_SUBSCRIPTION_SENTINEL_API_KEY);
		expect(provider?.baseUrl).toBe("cli://claude");
		expect(provider?.largeModel).toBe("claude-opus-4-7");
		expect(provider?.smallModel).toBe("claude-opus-4-7");
		expect(provider?.env).toMatchObject({
			ELIZA_CHAT_VIA_CLI: "claude",
			ELIZA_PLANNER_NATIVE_TOOLS: "0",
		});
	});

	it("honors ELIZA_CLI_CLAUDE_MODEL and passes CLI env through", () => {
		resetEnv();
		writeClaudeCredentials(tempHome);
		process.env.ELIZA_CHAT_VIA_CLI = "claude-sdk";
		process.env.ELIZA_CLI_CLAUDE_MODEL = "claude-sonnet-4-6";
		process.env.ELIZA_CLI_TIMEOUT_MS = "180000";

		const provider = selectLiveProvider();
		expect(provider?.name).toBe("cli");
		expect(provider?.largeModel).toBe("claude-sonnet-4-6");
		expect(provider?.env).toMatchObject({
			ELIZA_CHAT_VIA_CLI: "claude-sdk",
			ELIZA_CLI_CLAUDE_MODEL: "claude-sonnet-4-6",
			ELIZA_CLI_TIMEOUT_MS: "180000",
		});
	});

	it("resolves codex backends against ~/.codex/auth.json", () => {
		resetEnv();
		// claude creds alone must NOT satisfy a codex backend.
		writeClaudeCredentials(tempHome);
		process.env.ELIZA_CHAT_VIA_CLI = "codex";
		expect(selectLiveProvider()).toBeNull();

		writeCodexCredentials(tempHome);
		const provider = selectLiveProvider();
		expect(provider?.name).toBe("cli");
		expect(provider?.baseUrl).toBe("cli://codex");
		expect(provider?.largeModel).toBe("gpt-5.5");
	});

	it("keeps the cli provider LAST: a real API key wins", () => {
		resetEnv();
		writeClaudeCredentials(tempHome);
		process.env.ELIZA_CHAT_VIA_CLI = "claude";
		process.env.GROQ_API_KEY = "gsk-test-not-real";

		expect(availableProviderNames()).toEqual(
			expect.arrayContaining(["groq", "cli"]),
		);
		expect(selectLiveProvider()?.name).toBe("groq");
	});

	it("selects cli when explicitly preferred even with a real key present", () => {
		resetEnv();
		writeClaudeCredentials(tempHome);
		process.env.ELIZA_CHAT_VIA_CLI = "claude";
		process.env.GROQ_API_KEY = "gsk-test-not-real";

		expect(selectLiveProvider("cli")?.name).toBe("cli");
	});
});

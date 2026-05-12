import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DetectedProvider {
	id: string;
	source: string;
	apiKey?: string;
	authMode?: string;
	cliInstalled: boolean;
	status: "valid" | "invalid" | "unchecked" | "error";
	statusDetail?: string;
}

interface CodexAuthJson {
	auth_mode?: string;
	OPENAI_API_KEY?: string;
}

interface ClaudeCredentialsJson {
	claudeAiOauth?: {
		accessToken?: string;
		refreshToken?: string;
		expiresAt?: string;
	};
}

function extractOauthAccessToken(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const token =
				item && typeof item === "object" ? extractOauthAccessToken(item) : null;
			if (token) return token;
		}
		return null;
	}

	const record = value as Record<string, unknown>;
	const directToken = record.accessToken ?? record.access_token;
	if (typeof directToken === "string") {
		const trimmed = directToken.trim();
		if (trimmed.length > 0) return trimmed;
	}

	for (const nestedValue of Object.values(record)) {
		const token =
			nestedValue && typeof nestedValue === "object"
				? extractOauthAccessToken(nestedValue)
				: null;
		if (token) return token;
	}

	return null;
}

function readJsonFile<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const content = fs.readFileSync(filePath, "utf8");
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

function isTruthyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return (
		normalized.length > 0 &&
		normalized !== "0" &&
		normalized !== "false" &&
		normalized !== "no"
	);
}

async function isCliInstalled(name: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["which", name], {
			stdout: "pipe",
			stderr: "ignore",
		});
		await proc.exited;
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

async function readKeychainCredential(service: string): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const proc = Bun.spawn(
			["security", "find-generic-password", "-s", service, "-w"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		const output = await new Response(proc.stdout).text();
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

async function scanCodexCredentials(
	home: string,
): Promise<DetectedProvider | null> {
	const authPath = path.join(home, ".codex", "auth.json");
	const data = readJsonFile<CodexAuthJson>(authPath);
	if (!data?.OPENAI_API_KEY) return null;

	const cliInstalled = await isCliInstalled("codex");
	const authMode =
		typeof data.auth_mode === "string" && data.auth_mode.trim()
			? data.auth_mode.trim()
			: "api-key";
	return {
		id: authMode === "api-key" ? "openai" : "openai-subscription",
		source: "codex-auth",
		apiKey: data.OPENAI_API_KEY,
		authMode,
		cliInstalled,
		status: "unchecked",
	};
}

async function scanClaudeFileCredentials(
	home: string,
): Promise<DetectedProvider | null> {
	const credPath = path.join(home, ".claude", ".credentials.json");
	const data = readJsonFile<ClaudeCredentialsJson>(credPath);
	const token = extractOauthAccessToken(data);
	if (!token) return null;

	const cliInstalled = await isCliInstalled("claude");
	return {
		id: "anthropic-subscription",
		source: "claude-credentials",
		apiKey: token,
		authMode: "oauth",
		cliInstalled,
		status: "unchecked",
	};
}

async function scanClaudeKeychainCredentials(): Promise<DetectedProvider | null> {
	const keychainData = await readKeychainCredential("Claude Code-credentials");
	if (!keychainData) return null;

	// The keychain value may be a JSON blob with OAuth tokens
	try {
		const parsed = JSON.parse(keychainData) as Record<string, unknown>;
		const token = extractOauthAccessToken(parsed);
		if (!token) return null;

		const cliInstalled = await isCliInstalled("claude");
		return {
			id: "anthropic-subscription",
			source: "keychain",
			apiKey: token,
			authMode: "oauth",
			cliInstalled,
			status: "unchecked",
		};
	} catch {
		// Not JSON — treat the raw string as the credential
		const cliInstalled = await isCliInstalled("claude");
		return {
			id: "anthropic-subscription",
			source: "keychain",
			apiKey: keychainData,
			authMode: "oauth",
			cliInstalled,
			status: "unchecked",
		};
	}
}

// ── Copilot (GitHub) ──────────────────────────────────────────────────

interface CopilotHostsJson {
	[host: string]: { oauth_token?: string; user?: string };
}

async function scanCopilotCredentials(
	home: string,
): Promise<DetectedProvider | null> {
	// GitHub Copilot stores OAuth tokens in ~/.config/github-copilot/hosts.json
	const hostsPath = path.join(home, ".config", "github-copilot", "hosts.json");
	const data = readJsonFile<CopilotHostsJson>(hostsPath);
	if (!data) {
		// Try macOS keychain as fallback
		const keychainToken = await readKeychainCredential("copilot-cli");
		if (!keychainToken) return null;
		return {
			id: "openai-subscription",
			source: "copilot-keychain",
			apiKey: keychainToken,
			authMode: "oauth",
			cliInstalled: await isCliInstalled("gh"),
			status: "unchecked",
		};
	}

	// Find first host entry with an oauth_token
	for (const [, entry] of Object.entries(data)) {
		if (entry.oauth_token?.trim()) {
			return {
				id: "openai-subscription",
				source: "copilot-hosts",
				apiKey: entry.oauth_token.trim(),
				authMode: "oauth",
				cliInstalled: await isCliInstalled("gh"),
				status: "unchecked",
			};
		}
	}
	return null;
}

// ── Cursor ────────────────────────────────────────────────────────────

async function scanCursorCredentials(): Promise<DetectedProvider | null> {
	// Cursor stores auth in the macOS keychain under "Cursor Safe Storage"
	if (process.platform !== "darwin") return null;
	const keychainData = await readKeychainCredential("Cursor Safe Storage");
	if (!keychainData) return null;

	return {
		id: "cursor",
		source: "keychain",
		apiKey: keychainData,
		authMode: "oauth",
		cliInstalled: await isCliInstalled("cursor"),
		status: "unchecked",
	};
}

// ── Ollama (local) ────────────────────────────────────────────────────

async function scanOllamaLocal(): Promise<DetectedProvider | null> {
	// Check if Ollama is running by hitting its API
	try {
		const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
		// @duplicate-component-audit-allow: Ollama tags is local credential discovery, not generation.
		const res = await fetch(`${baseUrl}/api/tags`, {
			signal: AbortSignal.timeout(2000),
		});
		if (res.ok) {
			const data = (await res.json()) as { models?: unknown[] };
			const modelCount = data.models?.length ?? 0;
			return {
				id: "ollama",
				source: "local-server",
				authMode: "local",
				cliInstalled: true,
				status: "valid",
				statusDetail: `${modelCount} model${modelCount !== 1 ? "s" : ""} available`,
			};
		}
	} catch {
		// Not running — check if the binary exists
	}
	const cliInstalled = await isCliInstalled("ollama");
	if (cliInstalled) {
		return {
			id: "ollama",
			source: "cli-installed",
			authMode: "local",
			cliInstalled: true,
			status: "unchecked",
			statusDetail: "Ollama installed but not running",
		};
	}
	return null;
}

// ── Gemini CLI ────────────────────────────────────────────────────────

async function scanGeminiCredentials(
	home: string,
): Promise<DetectedProvider | null> {
	// Gemini CLI stores config in ~/.config/gemini/
	const configPath = path.join(home, ".config", "gemini", "settings.json");
	const data = readJsonFile<{ apiKey?: string }>(configPath);
	if (data?.apiKey?.trim()) {
		return {
			id: "gemini",
			source: "gemini-cli",
			apiKey: data.apiKey.trim(),
			authMode: "api-key",
			cliInstalled: await isCliInstalled("gemini"),
			status: "unchecked",
		};
	}
	// Also check for gcloud application default credentials
	const adcPath = path.join(
		home,
		".config",
		"gcloud",
		"application_default_credentials.json",
	);
	const adc = readJsonFile<{ client_id?: string; refresh_token?: string }>(
		adcPath,
	);
	if (adc?.refresh_token) {
		return {
			id: "gemini",
			source: "gcloud-adc",
			apiKey: adc.refresh_token,
			authMode: "oauth",
			cliInstalled: await isCliInstalled("gcloud"),
			status: "unchecked",
		};
	}
	return null;
}

// ── Browser cookie extraction (Chrome/Chromium on macOS) ──────────────────

interface ChromiumBrowserDef {
	name: string;
	cookiePath: string;
	keychainService: string;
}

const CHROMIUM_BROWSERS: ChromiumBrowserDef[] = [
	{
		name: "Chrome",
		cookiePath: "Google/Chrome/Default/Cookies",
		keychainService: "Chrome Safe Storage",
	},
	{
		name: "Arc",
		cookiePath: "Arc/User Data/Default/Cookies",
		keychainService: "Arc Safe Storage",
	},
	{
		name: "Brave",
		cookiePath: "BraveSoftware/Brave-Browser/Default/Cookies",
		keychainService: "Brave Safe Storage",
	},
	{
		name: "Edge",
		cookiePath: "Microsoft Edge/Default/Cookies",
		keychainService: "Microsoft Edge Safe Storage",
	},
	{
		name: "Chromium",
		cookiePath: "Chromium/Default/Cookies",
		keychainService: "Chromium Safe Storage",
	},
];

function deriveChromiumCookieKey(password: string): Buffer {
	// Chrome on macOS: PBKDF2 with salt='saltysalt', 1003 iterations, 16-byte key
	return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function decryptChromiumCookieValue(
	encrypted: Buffer,
	key: Buffer,
): string | null {
	// Chrome encrypted cookies start with 'v10' (3 bytes) then AES-128-CBC with 16 zero-byte IV
	if (encrypted.length < 4) return null;
	const version = encrypted.subarray(0, 3).toString("ascii");
	if (version !== "v10") return null;

	const ciphertext = encrypted.subarray(3);
	try {
		const iv = Buffer.alloc(16, 0);
		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		decipher.setAutoPadding(true);
		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		return decrypted.toString("utf8");
	} catch {
		return null;
	}
}

interface BrowserCookieResult {
	name: string;
	value: string;
	browser: string;
	expiresUtc: number;
}

/**
 * Read specific cookies from Chromium-based browsers on macOS.
 * Decrypts using the Safe Storage key from Keychain.
 * Falls back through installed browsers until one succeeds.
 */
export async function readChromiumCookies(
	host: string,
	cookieNames: string[],
): Promise<BrowserCookieResult[]> {
	if (process.platform !== "darwin") return [];

	const appSupport = path.join(os.homedir(), "Library", "Application Support");

	for (const browser of CHROMIUM_BROWSERS) {
		const dbPath = path.join(appSupport, browser.cookiePath);
		if (!fs.existsSync(dbPath)) continue;

		// Get the decryption key from Keychain
		const password = await readKeychainCredential(browser.keychainService);
		if (!password) continue;

		const key = deriveChromiumCookieKey(password);

		try {
			// Copy the DB to a temp file to avoid locking issues with the running browser
			const tmpDb = path.join(
				os.tmpdir(),
				`eliza-cookies-${browser.name}-${Date.now()}.db`,
			);
			fs.copyFileSync(dbPath, tmpDb);

			const db = new Database(tmpDb, { readonly: true });
			const nameParams = cookieNames.map(() => "?").join(", ");
			const rows = db
				.query(
					`SELECT name, encrypted_value, expires_utc FROM cookies WHERE host_key = ? AND name IN (${nameParams})`,
				)
				.all(host, ...cookieNames) as Array<{
				name: string;
				encrypted_value: Buffer;
				expires_utc: number;
			}>;
			db.close();

			// Clean up temp file
			try {
				fs.unlinkSync(tmpDb);
			} catch {
				/* best effort */
			}

			const results: BrowserCookieResult[] = [];
			for (const row of rows) {
				const value = decryptChromiumCookieValue(
					Buffer.from(row.encrypted_value),
					key,
				);
				if (value) {
					results.push({
						name: row.name,
						value,
						browser: browser.name,
						expiresUtc: row.expires_utc,
					});
				}
			}

			if (results.length > 0) return results;
		} catch (err) {
			console.warn(
				`[credentials] Failed to read ${browser.name} cookies:`,
				err,
			);
		}
	}

	return [];
}

// ── Eliza Cloud (browser cookie auto-import) ─────────────────────────

async function scanElizaCloudBrowserSession(): Promise<DetectedProvider | null> {
	// Check if user has an active elizacloud.ai session in their browser.
	// The privy-token JWT is in-memory only (not persisted to SQLite),
	// but privy-session indicates an active browser session exists.
	const cookies = await readChromiumCookies("www.elizacloud.ai", [
		"privy-session",
	]);

	const hasSession = cookies.some((c) => c.name === "privy-session");
	if (!hasSession) return null;

	// The user is logged into elizacloud.ai in their browser.
	// The "Deploy to Cloud" flow will open the browser and complete
	// auth instantly since they already have a session (no re-login).
	return {
		id: "elizacloud",
		source: "browser-session",
		authMode: "oauth",
		cliInstalled: false,
		status: "unchecked",
		statusDetail: "Logged in via browser",
	};
}

/**
 * Environment variable → provider ID mapping for all Eliza AI providers.
 * Each entry maps an env var name to its provider plugin ID.
 */
const ENV_PROVIDER_MAP: Array<{
	envVar: string;
	providerId: string;
	authMode: string;
	includeValue?: boolean;
}> = [
	{ envVar: "OPENAI_API_KEY", providerId: "openai", authMode: "api-key" },
	{
		envVar: "ANTHROPIC_API_KEY",
		providerId: "anthropic",
		authMode: "api-key",
	},
	{ envVar: "GROQ_API_KEY", providerId: "groq", authMode: "api-key" },
	{
		envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
		providerId: "gemini",
		authMode: "api-key",
	},
	{ envVar: "GOOGLE_API_KEY", providerId: "gemini", authMode: "api-key" },
	{
		envVar: "OPENROUTER_API_KEY",
		providerId: "openrouter",
		authMode: "api-key",
	},
	{ envVar: "XAI_API_KEY", providerId: "grok", authMode: "api-key" },
	{
		envVar: "DEEPSEEK_API_KEY",
		providerId: "deepseek",
		authMode: "api-key",
	},
	{
		envVar: "MISTRAL_API_KEY",
		providerId: "mistral",
		authMode: "api-key",
	},
	{
		envVar: "TOGETHER_API_KEY",
		providerId: "together",
		authMode: "api-key",
	},
	{ envVar: "ZAI_API_KEY", providerId: "zai", authMode: "api-key" },
	{
		envVar: "OLLAMA_BASE_URL",
		providerId: "ollama",
		authMode: "local",
		includeValue: true,
	},
	{
		envVar: "ELIZAOS_CLOUD_API_KEY",
		providerId: "elizacloud",
		authMode: "cloud",
	},
	{
		envVar: "AI_GATEWAY_API_KEY",
		providerId: "vercel-ai-gateway",
		authMode: "api-key",
	},
	{
		envVar: "AIGATEWAY_API_KEY",
		providerId: "vercel-ai-gateway",
		authMode: "api-key",
	},
];

function scanEnvCredentials(): DetectedProvider[] {
	const results: DetectedProvider[] = [];
	const seen = new Set<string>();

	for (const {
		envVar,
		providerId,
		authMode,
		includeValue,
	} of ENV_PROVIDER_MAP) {
		if (seen.has(providerId)) continue;
		const value = process.env[envVar];
		const hasValue =
			includeValue === false ? isTruthyFlag(value) : Boolean(value?.trim());
		if (hasValue) {
			seen.add(providerId);
			results.push({
				id: providerId,
				source: "env",
				apiKey: includeValue === false ? undefined : value?.trim(),
				authMode,
				cliInstalled: false,
				status: "unchecked",
			});
		}
	}

	return results;
}

/** Mask a credential string, showing only the last 4 characters. */
function maskApiKey(key: string | undefined): string | undefined {
	if (!key) return key;
	if (key.length <= 4) return "****";
	return `****${key.slice(-4)}`;
}

/** Mask API keys in provider results before returning over IPC. */
function maskProviders(providers: DetectedProvider[]): DetectedProvider[] {
	return providers.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) }));
}

/**
 * Internal: collect raw providers with full API keys.
 * Only used within this module for validation; never exported.
 */
async function scanProviderCredentialsRaw(): Promise<DetectedProvider[]> {
	const home = os.homedir();
	const detected = new Map<string, DetectedProvider>();

	// File-based credentials (highest priority)
	const [codex, claudeFile, copilot, geminiCli, ollamaLocal] =
		await Promise.all([
			scanCodexCredentials(home),
			scanClaudeFileCredentials(home),
			scanCopilotCredentials(home),
			scanGeminiCredentials(home),
			scanOllamaLocal(),
		]);

	if (codex) detected.set(codex.id, codex);
	if (claudeFile) detected.set(claudeFile.id, claudeFile);
	if (copilot && !detected.has(copilot.id)) detected.set(copilot.id, copilot);
	if (geminiCli && !detected.has(geminiCli.id))
		detected.set(geminiCli.id, geminiCli);
	if (ollamaLocal) detected.set(ollamaLocal.id, ollamaLocal);

	// Keychain (fills gaps for providers not yet found from files)
	if (!detected.has("anthropic-subscription")) {
		const keychainResult = await scanClaudeKeychainCredentials();
		if (keychainResult) detected.set(keychainResult.id, keychainResult);
	}
	if (!detected.has("cursor")) {
		const cursorResult = await scanCursorCredentials();
		if (cursorResult) detected.set(cursorResult.id, cursorResult);
	}

	// Browser cookies (Eliza Cloud session import)
	if (!detected.has("elizacloud")) {
		const cloudSession = await scanElizaCloudBrowserSession();
		if (cloudSession) detected.set(cloudSession.id, cloudSession);
	}

	// Environment variables (lowest priority — only fills gaps)
	for (const envProvider of scanEnvCredentials()) {
		if (!detected.has(envProvider.id)) {
			detected.set(envProvider.id, envProvider);
		}
	}

	return Array.from(detected.values());
}

/**
 * Scan all known credential sources and return detected providers.
 * Checks files → keychain → env vars, deduplicating by provider ID
 * (first match wins per provider).
 *
 * API keys are masked in the returned results (last 4 chars only) to
 * prevent accidental exposure via IPC or logging.
 */
export async function scanProviderCredentials(): Promise<DetectedProvider[]> {
	return maskProviders(await scanProviderCredentialsRaw());
}

export async function scanAndValidateProviderCredentials(): Promise<
	DetectedProvider[]
> {
	// Validate with full keys, then mask before returning
	const raw = await scanProviderCredentialsRaw();
	const validated = await Promise.all(raw.map(validateProvider));
	return maskProviders(validated);
}

/**
 * Provider validation endpoints. Each entry maps a provider ID to its
 * models/health endpoint and how to pass the API key.
 */
const VALIDATION_ENDPOINTS: Record<
	string,
	{ url: string; authHeader: (key: string) => Record<string, string> }
> = {
	openai: {
		url: "https://api.openai.com/v1/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	anthropic: {
		url: "https://api.anthropic.com/v1/models",
		authHeader: (key) => ({
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
		}),
	},
	groq: {
		url: "https://api.groq.com/openai/v1/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	gemini: {
		url: "https://generativelanguage.googleapis.com/v1beta/models",
		authHeader: (key) => ({ "x-goog-api-key": key }),
	},
	openrouter: {
		url: "https://openrouter.ai/api/v1/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	grok: {
		url: "https://api.x.ai/v1/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	deepseek: {
		url: "https://api.deepseek.com/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	mistral: {
		url: "https://api.mistral.ai/v1/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	together: {
		url: "https://api.together.xyz/v1/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	zai: {
		url: "https://api.z.ai/api/paas/v4/models",
		authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
	},
};

async function validateProvider(
	p: DetectedProvider,
): Promise<DetectedProvider> {
	if (!p.apiKey || p.authMode === "oauth") {
		return { ...p, status: "unchecked" };
	}
	const endpoint = VALIDATION_ENDPOINTS[p.id];
	if (!endpoint) {
		return { ...p, status: "unchecked" };
	}
	try {
		const res = await fetch(endpoint.url, {
			headers: endpoint.authHeader(p.apiKey),
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) return { ...p, status: "valid" };
		if (res.status === 401 || res.status === 403)
			return { ...p, status: "invalid", statusDetail: "API key rejected" };
		return { ...p, status: "error", statusDetail: `HTTP ${res.status}` };
	} catch (err) {
		return {
			...p,
			status: "error",
			statusDetail: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

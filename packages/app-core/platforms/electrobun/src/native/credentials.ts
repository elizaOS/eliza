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
  const [codex, claudeFile] = await Promise.all([
    scanCodexCredentials(home),
    scanClaudeFileCredentials(home),
  ]);

  if (codex) detected.set(codex.id, codex);
  if (claudeFile) detected.set(claudeFile.id, claudeFile);

  // Keychain (only if no Claude subscription credential was detected from file)
  if (!detected.has("anthropic-subscription")) {
    const keychainResult = await scanClaudeKeychainCredentials();
    if (keychainResult) detected.set(keychainResult.id, keychainResult);
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

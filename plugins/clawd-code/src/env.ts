import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

const CONFIG_ENV_FILE = join(homedir(), '.clawd-code', '.env');
const LOCAL_ENV_FILE = resolve(process.cwd(), '.env');

/** Standard Grok config locations — both project and user. */
const GROK_USER_CONFIG = join(homedir(), '.grok', 'config.toml');
const GROK_PROJECT_CONFIG = resolve(process.cwd(), '.grok', 'config.toml');

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  const vars: Record<string, string> = {};
  const env = readFileSync(path, 'utf-8');

  for (const rawLine of env.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const exportPrefix = 'export ';
    const normalized = line.startsWith(exportPrefix) ? line.slice(exportPrefix.length).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator === -1) continue;

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!key) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

export function upsertEnvFile(path: string, values: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
  const remaining = new Map(Object.entries(values));
  const lines = existing.map((rawLine) => {
    const line = rawLine.trim();
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = normalized.indexOf('=');
    if (!line || line.startsWith('#') || separator === -1) return rawLine;

    const key = normalized.slice(0, separator).trim();
    if (!remaining.has(key)) return rawLine;

    const next = `${key}=${remaining.get(key) ?? ''}`;
    remaining.delete(key);
    return rawLine.trim().startsWith('export ') ? `export ${next}` : next;
  });

  for (const [key, value] of remaining) {
    lines.push(`${key}=${value}`);
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/g, '')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function upsertClawdEnv(values: Record<string, string>): void {
  upsertEnvFile(CONFIG_ENV_FILE, values);
}

/**
 * Minimal Grok-compatible config.toml parser.
 * Supports the subset of TOML we actually use:
 *   [models]
 *   default = "glm-5.2"
 *
 *   [model.grok-fast]
 *   model = "grok-4.3-fast"
 *   base_url = "https://api.x.ai/v1"
 *   name = "Grok Fast"
 *   env_key = "XAI_API_KEY"
 *
 * Quotes, single-line comments (`#`), and `[section]` headers are handled.
 * Returns a flat record of resolved env-var-style keys plus a list of model
 * aliases keyed by their declared name.
 */
export function parseGrokConfigToml(path: string): {
  flat: Record<string, string>;
  defaultModel?: string;
  modelAliases: Record<string, { model: string; baseUrl?: string; name?: string; envKey?: string }>;
} {
  if (!existsSync(path)) return { flat: {}, modelAliases: {} };

  const flat: Record<string, string> = {};
  const modelAliases: Record<string, { model: string; baseUrl?: string; name?: string; envKey?: string }> = {};
  let currentSection: string | null = null;
  let currentModelKey: string | null = null;

  const lines = readFileSync(path, 'utf-8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      const section = line.slice(1, -1).trim();
      currentSection = section;
      if (section.startsWith('model.')) {
        currentModelKey = section.slice('model.'.length).trim();
      } else {
        currentModelKey = null;
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip inline comment
    const hashIdx = value.indexOf('#');
    if (hashIdx !== -1 && !value.startsWith('"') && !value.startsWith("'")) {
      value = value.slice(0, hashIdx).trim();
    }
    // strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    if (currentSection === 'models' && key === 'default') {
      flat.CLAWD_MODEL = value;
    } else if (currentSection && currentSection.startsWith('model.') && currentModelKey) {
      const slot = modelAliases[currentModelKey] ?? (modelAliases[currentModelKey] = { model: '' });
      if (key === 'model') slot.model = value;
      else if (key === 'base_url') slot.baseUrl = value;
      else if (key === 'name') slot.name = value;
      else if (key === 'env_key') {
        slot.envKey = value;
        flat[value] = flat[value] ?? process.env[value] ?? '';
      }
    } else if (currentSection === 'ui' && key === 'permission_mode') {
      flat.CLAWD_PERMISSION_MODE = value;
    } else if (currentSection === 'session' && key === 'auto_compact_threshold_percent') {
      flat.CLAWD_AUTO_COMPACT = value;
    } else if (currentSection === 'cli' && key === 'auto_update') {
      flat.CLAWD_NO_AUTO_UPDATE = value === 'false' ? 'true' : '';
    }
  }

  // Default model for the harness is CLAWD_MODEL (or provider default in caller).
  return { flat, defaultModel: flat.CLAWD_MODEL, modelAliases };
}

/**
 * Merge Grok config.toml entries from project (.grok/config.toml) then user
 * (~/.grok/config.toml) into the env-var bag. Project overrides user (matches
 * 12-factor precedence and matches how Grok discovers config).
 */
export function loadGrokConfig(): {
  flat: Record<string, string>;
  sources: string[];
  modelAliases: Record<string, { model: string; baseUrl?: string; name?: string; envKey?: string }>;
} {
  const sources: string[] = [];
  const merged: Record<string, string> = {};
  const aliases: Record<string, { model: string; baseUrl?: string; name?: string; envKey?: string }> = {};

  for (const path of [GROK_USER_CONFIG, GROK_PROJECT_CONFIG]) {
    if (!existsSync(path)) continue;
    const parsed = parseGrokConfigToml(path);
    sources.push(path);
    for (const [k, v] of Object.entries(parsed.flat)) {
      // later (project) wins over earlier (user)
      merged[k] = v;
    }
    for (const [k, v] of Object.entries(parsed.modelAliases)) {
      aliases[k] = v;
    }
  }

  return { flat: merged, sources, modelAliases: aliases };
}

export function loadClawdEnv(): Record<string, string> {
  const localEnv = parseEnvFile(LOCAL_ENV_FILE);
  const configEnv = parseEnvFile(CONFIG_ENV_FILE);
  const grokConfig = loadGrokConfig();

  // Precedence (low → high): ~/.clawd-code/.env  <  ./.env  <  ~/.grok/config.toml  <  ./.grok/config.toml  <  process.env
  const merged: Record<string, string> = {
    ...configEnv,
    ...localEnv,
    ...grokConfig.flat,
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return merged;
}

export function maskSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 10) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export const ENV_FILE_PATHS = {
  config: CONFIG_ENV_FILE,
  local: LOCAL_ENV_FILE,
  grokUser: GROK_USER_CONFIG,
  grokProject: GROK_PROJECT_CONFIG,
};

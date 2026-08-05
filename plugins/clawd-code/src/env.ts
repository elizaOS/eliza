import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const CONFIG_ENV_FILE = join(homedir(), '.clawd-code', '.env');
const LOCAL_ENV_FILE = resolve(process.cwd(), '.env');

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

export function loadClawdEnv(): Record<string, string> {
  const localEnv = parseEnvFile(LOCAL_ENV_FILE);
  const configEnv = parseEnvFile(CONFIG_ENV_FILE);
  const merged: Record<string, string> = { ...localEnv, ...configEnv };

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

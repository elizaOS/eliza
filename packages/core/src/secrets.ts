import { type Character } from './types';
import { detectEnvironment } from './utils/environment';

let allowedEnvVars: Set<string> | null = null;

export function setAllowedEnvVars(vars: Set<string> | null): void {
  allowedEnvVars = vars;
}

export function getAllowedEnvVars(): Set<string> | null {
  return allowedEnvVars;
}

export function hasCharacterSecrets(character: Character): boolean {
  const secrets = character?.settings?.secrets;
  if (!secrets || typeof secrets !== 'object') return false;
  // Use for...in with early return instead of Object.keys().length > 0
  // which allocates an array just to check if it's non-empty
  for (const _ in secrets) {
    return true;
  }
  return false;
}

/**
 * Merges process.env into character.settings.secrets with character values taking precedence.
 * Node.js-only - returns false in browser environments.
 */
export async function setDefaultSecretsFromEnv(
  character: Character,
  options?: { skipEnvMerge?: boolean }
): Promise<boolean> {
  if (detectEnvironment() !== 'node' || options?.skipEnvMerge) {
    return false;
  }

  const envVars: Record<string, string> = {};

  // Optimization: when allowedEnvVars is set, iterate over the smaller set
  // This is more efficient when allowedEnvVars is much smaller than process.env
  if (allowedEnvVars !== null) {
    // Iterate over allowed vars and check if they exist in process.env
    for (const key of allowedEnvVars) {
      const value = process.env[key];
      if (value !== undefined) {
        envVars[key] = value;
      }
    }
  } else {
    // No filter - iterate over all process.env
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        envVars[key] = value;
      }
    }
  }

  character.settings ??= {};

  const existingSecrets =
    character.settings.secrets && typeof character.settings.secrets === 'object'
      ? { ...(character.settings.secrets as Record<string, string>) }
      : {};

  character.settings.secrets = { ...envVars, ...existingSecrets };

  return true;
}

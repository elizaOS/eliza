import type { Character } from "./types";
import { detectEnvironment } from "./utils/environment";

export function hasCharacterSecrets(character: Character): boolean {
  return Boolean(
    character.secrets && Object.keys(character.secrets).length > 0,
  );
}

async function loadSecretsNodeImpl(character: Character): Promise<boolean> {
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      envVars[key] = value;
    }
  }

  const existingSecrets = character.secrets ? { ...character.secrets } : {};

  character.secrets = {
    ...envVars,
    ...existingSecrets,
  };

  return true;
}

export async function setDefaultSecretsFromEnv(
  character: Character,
  options?: { skipEnvMerge?: boolean },
): Promise<boolean> {
  const env = detectEnvironment();

  if (env !== "node") {
    return false;
  }

  if (options?.skipEnvMerge) {
    return false;
  }

  return loadSecretsNodeImpl(character);
}

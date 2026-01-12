import type { Character } from "./types";
import { detectEnvironment } from "./utils/environment";

export function hasCharacterSecrets(character: Character): boolean {
  const characterSettings = character?.settings;
  const characterSettingsSecrets = characterSettings?.secrets;
  return Boolean(
    characterSettingsSecrets &&
      Object.keys(characterSettingsSecrets).length > 0,
  );
}

async function loadSecretsNodeImpl(character: Character): Promise<boolean> {
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      envVars[key] = value;
    }
  }

  if (!character.settings) {
    character.settings = {};
  }

  const existingSecrets =
    character.settings.secrets && typeof character.settings.secrets === "object"
      ? { ...(character.settings.secrets as Record<string, string>) }
      : {};

  character.settings.secrets = {
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

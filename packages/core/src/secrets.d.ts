import { type Character } from './types';
/**
 * Validates if a character has secrets configured
 * Migrated from packages/server/src/managers/ConfigManager.ts
 */
export declare function hasCharacterSecrets(character: Character): boolean;
/**
 * Sets default secrets from local .env if character doesn't have any
 * Returns true if secrets were set, false otherwise
 *
 * Note: This is a Node.js-only feature. In browser environments, it returns false.
 */
export declare function setDefaultSecretsFromEnv(character: Character): Promise<boolean>;
//# sourceMappingURL=secrets.d.ts.map
/**
 * Core configuration modules for ElizaOS
 * Provides character parsing, environment loading, and secrets management
 */

// Character configuration utilities
export { parseCharacter, validateCharacterConfig, mergeCharacterDefaults } from './character';

// Environment configuration utilities
export { findEnvFile, loadEnvConfig } from './environment';

// Secrets management utilities
export { hasCharacterSecrets, setDefaultSecretsFromEnv } from './secrets';
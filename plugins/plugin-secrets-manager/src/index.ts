import type { Plugin } from "@elizaos/core";
import { EnhancedSecretManager } from "./enhanced-service";
import { NgrokService } from "./services/ngrok-service";
import { SecretFormService } from "./services/secret-form-service";
import { envStatusProvider } from "./providers/envStatus";
import { secretsInfoProvider } from "./providers/secretsInfo";
import { setEnvVarAction } from "./actions/setEnvVar";
import { generateEnvVarAction } from "./actions/generateEnvVar";
import { manageSecretAction } from "./actions/manageSecret";
import { requestSecretFormAction } from "./actions/requestSecretForm";
import { envScenariosSuite } from "./e2e/env-scenarios";
import { envPersistenceSuite } from "./e2e/env-persistence";
import { secretFormsSuite } from "./e2e/secret-forms";
import { secretsScenariosSuite } from "./e2e/scenarios.e2e";

/**
 * Secrets and Environment Variable Management Plugin
 *
 * This plugin provides comprehensive secret and environment variable management for autonomous agents:
 * - Multi-level secret management (global, world, user) with encryption and access control
 * - Automatic detection of required environment variables from plugins
 * - Auto-generation of variables that can be created programmatically (keys, secrets, etc.)
 * - User interaction for variables that require manual input (API keys, etc.)
 * - Validation of environment variables to ensure they work correctly
 * - Persistent storage in character secrets with runtime integration
 * - Component-based user secret storage for multi-tenancy
 * - Permission-based access control for world and user secrets
 */
export const envPlugin: Plugin = {
  name: "plugin-env",
  description:
    "Secret and environment variable management with multi-level support, auto-generation and validation capabilities",

  services: [EnhancedSecretManager, NgrokService, SecretFormService],

  providers: [envStatusProvider, secretsInfoProvider],

  actions: [
    setEnvVarAction,
    generateEnvVarAction,
    manageSecretAction,
    requestSecretFormAction,
  ],

  tests: [
    envScenariosSuite,
    envPersistenceSuite,
    secretFormsSuite,
    secretsScenariosSuite,
  ],

  init: async (config, runtime) => {
    // Initialize the enhanced secret manager service
    // The service will automatically scan for required environment variables,
    // load them from character secrets into runtime settings,
    // and prepare multi-level secret storage
  },
};

export default envPlugin;

// Export types for use by other plugins
export type {
  EnvVarConfig,
  EnvVarMetadata,
  EnvVarUpdate,
  GenerationScript,
  GenerationScriptMetadata,
  ValidationResult,
  SecretConfig,
  SecretContext,
  SecretMetadata,
  SecretPermission,
  EncryptedSecret,
  SecretAccessLog,
} from "./types";

export type {
  FormField,
  FormFieldType,
  FormSchema,
  FormSession,
  FormSubmission,
  SecretFormRequest,
  ValidationRule,
} from "./types/form";

// Export utility functions
export {
  canGenerateEnvVar,
  generateScript,
  getGenerationDescription,
} from "./generation";

export { validateEnvVar, validationStrategies } from "./validation";

// Export services for direct access if needed
export { EnvManagerService } from "./service";
export { EnhancedSecretManager } from "./enhanced-service";

// Export migration utilities
export { SecretMigrationHelper, runMigration } from "./migration";

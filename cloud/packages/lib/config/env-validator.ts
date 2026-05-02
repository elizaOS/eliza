/**
 * Environment Variable Validation
 *
 * Validates required environment variables on application startup.
 */

import { shouldBlockDevnetBypass } from "@/lib/config/deployment-environment";
import { logger } from "@/lib/utils/logger";

/**
 * Error information for a validation failure.
 */
export interface EnvValidationError {
  variable: string;
  message: string;
  required: boolean;
}

/**
 * Result of environment validation.
 */
export interface EnvValidationResult {
  /** Whether all required variables are valid. */
  valid: boolean;
  /** List of validation errors. */
  errors: EnvValidationError[];
  /** List of validation warnings. */
  warnings: EnvValidationError[];
}

/**
 * Environment variable definitions
 */
const ENV_VARS = {
  // Database - Single database for platform and elizaOS
  DATABASE_URL: {
    required: true,
    description: "PostgreSQL connection string (platform + elizaOS tables)",
    validate: (value: string) =>
      value.startsWith("postgresql://") || value.startsWith("postgres://"),
    errorMessage: "Must be a valid PostgreSQL connection string",
  },

  // Steward Authentication (sole auth provider)
  NEXT_PUBLIC_STEWARD_API_URL: {
    required: false,
    default: "/steward",
    description: "Optional Steward API base URL override; defaults to same-origin /steward",
    validate: (value: string) => {
      const trimmed = value.trim();
      return trimmed.length > 0 && (trimmed.startsWith("/steward") || /^https?:\/\//.test(trimmed));
    },
    errorMessage: "Must be an http(s) URL or same-origin /steward path",
  },
  STEWARD_SESSION_SECRET: {
    required: true,
    description: "HS256 secret used to verify Steward session JWTs (must match Steward host)",
    validate: (value: string) => value.trim().length >= 32,
    errorMessage: "Must be at least 32 characters",
  },

  // AI Services
  OPENAI_API_KEY: {
    required: false,
    description: "OpenAI API key for Eliza serverless",
    validate: (value: string) => value.startsWith("sk-"),
    errorMessage: "Must start with 'sk-'",
  },
  GOOGLE_API_KEY: {
    required: false,
    description: "Google AI API key for hosted Gemini-grounded search",
    validate: (value: string) => value.trim().length > 0,
    errorMessage: "Must not be empty",
  },
  GEMINI_API_KEY: {
    required: false,
    description: "Gemini API key alias for hosted Google search",
    validate: (value: string) => value.trim().length > 0,
    errorMessage: "Must not be empty",
  },
  GOOGLE_GENERATIVE_AI_API_KEY: {
    required: false,
    description: "Legacy Google Generative AI API key alias for hosted search",
    validate: (value: string) => value.trim().length > 0,
    errorMessage: "Must not be empty",
  },
  ANTHROPIC_COT_BUDGET: {
    required: false,
    // Note: 0 is treated as "disabled" by parseAnthropicCotBudgetFromEnv (returns null).
    // Only positive integers enable thinking. Invalid non-empty values throw at runtime,
    // so we fail fast at startup with failOnInvalid: true.
    failOnInvalid: true,
    description:
      "Default Anthropic extended-thinking token budget when a character omits settings.anthropicThinkingBudgetTokens. Positive integer to enable; unset or empty to disable (0 is treated as disabled at runtime)",
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed === "") {
        return false;
      }
      if (!/^\d+$/.test(trimmed)) {
        return false;
      }
      const n = Number.parseInt(trimmed, 10);
      // 0 is valid (means disabled), positive integers enable thinking
      return n >= 0 && n <= Number.MAX_SAFE_INTEGER;
    },
    errorMessage:
      "Must be a non-negative integer (0 is valid but treated as disabled at runtime; use unset/empty to disable, positive integer to enable thinking)",
  },

  ANTHROPIC_COT_BUDGET_MAX: {
    required: false,
    // Note: Invalid non-empty values here trigger request-time exceptions in anthropic-thinking.ts.
    // Validation failures for this variable should be treated as errors (not warnings) to fail fast.
    failOnInvalid: true,
    description:
      "Optional ceiling (tokens) for any effective Anthropic thinking budget (character setting or env default). Unset = no cap",
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed === "") {
        return false;
      }
      if (!/^\d+$/.test(trimmed)) {
        return false;
      }
      const n = Number.parseInt(trimmed, 10);
      return n >= 0 && n <= Number.MAX_SAFE_INTEGER;
    },
    errorMessage: "Must be a non-negative integer string (0 = no cap)",
  },

  RATE_LIMIT_MULTIPLIER: {
    required: false,
    failOnInvalid: true,
    description:
      "Multiplier for rate limit thresholds (e.g., 100 for 100x limits in dev). Defaults to 1 (production limits). Ignored in production.",
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed === "") {
        return false;
      }
      // Only accept positive integers (no floats) to match runtime parseInt behavior
      if (!/^\d+$/.test(trimmed)) {
        return false;
      }
      const n = Number.parseInt(trimmed, 10);
      return n >= 1 && n <= Number.MAX_SAFE_INTEGER;
    },
    errorMessage: "Must be a positive integer >= 1 (e.g., 1, 10, 100)",
  },

  // Stripe (optional)
  STRIPE_SECRET_KEY: {
    required: false,
    description: "Stripe secret key for payments",
    validate: (value: string) => value.startsWith("sk_test_") || value.startsWith("sk_live_"),
    errorMessage: "Must start with 'sk_test_' or 'sk_live_'",
  },
  STRIPE_WEBHOOK_SECRET: {
    required: false,
    description: "Stripe webhook secret",
    validate: (value: string) => value.startsWith("whsec_"),
    errorMessage: "Must start with 'whsec_'",
  },

  // OxaPay Crypto Payments (optional - for crypto payment feature)
  OXAPAY_MERCHANT_API_KEY: {
    required: false,
    description: "OxaPay merchant API key for crypto payments",
    validate: (value: string) => value.length >= 32,
    errorMessage: "Must be at least 32 characters",
  },

  // Signup codes (optional - JSON object { "codes": { "<code>": <amount>, ... } })
  SIGNUP_CODES_JSON: {
    required: false,
    description: "Signup code bonuses as JSON; default {} if unset",
    validate: (value: string) => {
      try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null;
      } catch {
        return false;
      }
    },
    errorMessage: "Must be valid JSON object",
  },

  // Cron Jobs
  CRON_SECRET: {
    required: true,
    description: "Secret for authenticating cron job requests (required for production security)",
    validate: (value: string) => value.length >= 32,
    errorMessage: "Must be at least 32 characters for security",
  },

  // Solana RPC
  SOLANA_RPC_PROVIDER_API_KEY: {
    required: false,
    description: "Solana RPC provider API key (enables Solana blockchain access)",
    validate: (value: string) => value.trim().length > 0,
    errorMessage: "Must not be empty",
  },

  // Market Data API
  MARKET_DATA_PROVIDER_API_KEY: {
    required: false,
    description: "Market data API key (enables multi-chain token price and market data)",
    validate: (value: string) => value.trim().length > 0,
    errorMessage: "Must not be empty",
  },

  // Alchemy EVM RPC
  ALCHEMY_API_KEY: {
    required: false,
    description: "Alchemy API key (enables EVM blockchain access via /api/v1/rpc/*)",
    validate: (value: string) => value.trim().length > 0,
    errorMessage: "Must not be empty",
  },
} as const;

/**
 * Validates all environment variables.
 *
 * @returns Validation result with errors and warnings.
 */
export function validateEnvironment(): EnvValidationResult {
  const errors: EnvValidationError[] = [];
  const warnings: EnvValidationError[] = [];

  for (const [variable, config] of Object.entries(ENV_VARS)) {
    const value = process.env[variable];

    // Check if required variable is missing
    if (config.required && !value) {
      errors.push({
        variable,
        message: `${variable} is required but not set. ${config.description}`,
        required: true,
      });
      continue;
    }

    // Skip validation if variable is not set and not required
    if (!value) {
      if (!config.required && !("default" in config && config.default)) {
        warnings.push({
          variable,
          message: `${variable} is not set. ${config.description}. Some features may be unavailable.`,
          required: false,
        });
      }
      continue;
    }

    // Validate format if validator is provided
    if ("validate" in config && config.validate && !config.validate(value)) {
      const errorMsg =
        "errorMessage" in config && config.errorMessage ? config.errorMessage : "Invalid format";
      // Treat as error if required OR if failOnInvalid is set (for optional vars that throw at runtime)
      const treatAsError = config.required || ("failOnInvalid" in config && config.failOnInvalid);
      if (treatAsError) {
        errors.push({
          variable,
          message: `${variable}: ${errorMsg}`,
          required: config.required,
        });
      } else {
        warnings.push({
          variable,
          message: `${variable}: ${errorMsg}. Feature may not work correctly.`,
          required: false,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates environment and throws if invalid.
 *
 * Use this on application startup. Logs warnings and throws on errors.
 *
 * @throws Error if environment validation fails.
 */
export function requireValidEnvironment(): void {
  const result = validateEnvironment();

  // Log warnings
  if (result.warnings.length > 0) {
    console.warn("⚠️  Environment warnings:");
    for (const warning of result.warnings) {
      console.warn(`  - ${warning.message}`);
    }
    console.warn("");
  }

  // Throw on errors
  if (!result.valid) {
    console.error("❌ Environment validation failed:");
    for (const error of result.errors) {
      console.error(`  - ${error.message}`);
    }
    console.error("");
    console.error("Please check your .env.local file and set the required variables.");
    console.error("See .env.example for reference.");
    throw new Error("Invalid environment configuration");
  }

  // CRITICAL: Prevent production from running with devnet admin bypass
  if (shouldBlockDevnetBypass(process.env)) {
    console.error("");
    console.error("🚨 SECURITY ERROR: Production environment with DEVNET=true");
    console.error("   This enables admin bypass for anvil wallet (0xf39F...)");
    console.error("   DEVNET=true must NEVER be set in production.");
    console.error("");
    throw new Error("DEVNET=true is not allowed in production");
  }

  logger.info("✅ Environment validation passed");
  if (result.warnings.length > 0) {
    logger.info(
      `⚠️  ${result.warnings.length} optional variable(s) not set - some features may be unavailable`,
    );
  }
  logger.info("");
}

/**
 * Checks if a specific feature is configured.
 *
 * @param feature - Feature name ("containers", "stripe", "blob", "ai").
 * @returns True if the feature is configured.
 */
export function isFeatureConfigured(feature: string): boolean {
  switch (feature) {
    case "containers":
      // Hetzner-Docker control plane: nodes are seeded either via the admin
      // API (DB-backed, no env required) or via the AGENT_DOCKER_NODES
      // env var (seed-only fallback). Either way, an SSH key is required.
      return !!(process.env.AGENT_SSH_KEY || process.env.AGENT_SSH_KEY_PATH);
    case "stripe":
      return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
    case "crypto":
      return !!process.env.OXAPAY_MERCHANT_API_KEY;
    case "cron":
      return !!process.env.CRON_SECRET;
    case "ai":
      return !!(
        process.env.OPENROUTER_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.GROQ_API_KEY
      );
    default:
      return false;
  }
}

/**
 * Gets a list of all configured features.
 *
 * @returns Array of configured feature names.
 */
export function getConfiguredFeatures(): string[] {
  const features = ["containers", "stripe", "crypto", "cron", "ai"];
  return features.filter((f) => isFeatureConfigured(f));
}

/**
 * Logs configuration status on startup.
 *
 * Prints which features are enabled/disabled.
 */
export function logConfigurationStatus(): void {
  logger.info("📋 Feature Configuration Status:");

  const features = [
    { name: "Container Deployments", key: "containers" },
    { name: "Stripe Payments", key: "stripe" },
    { name: "Crypto Payments (OxaPay)", key: "crypto" },
    { name: "Cron Jobs", key: "cron" },
    { name: "AI Services", key: "ai" },
  ];

  for (const feature of features) {
    const configured = isFeatureConfigured(feature.key);
    const status = configured ? "✅ Enabled" : "⚠️  Disabled";
    logger.info(`  ${status} - ${feature.name}`);
  }

  logger.info("");
}

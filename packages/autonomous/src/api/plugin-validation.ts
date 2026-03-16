/**
 * Plugin configuration validation.
 *
 * Validates plugin configuration by checking all required parameters
 * from the plugin's agentConfig.pluginParameters definition, plus
 * provider-specific API key format checks.
 *
 * Also provides runtime context validation to detect null, undefined,
 * empty, and non-serializable fields in context objects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginValidationResult {
  /** Whether the plugin configuration is valid (no errors). */
  valid: boolean;
  /** Hard errors that prevent the plugin from working. */
  errors: Array<{ field: string; message: string }>;
  /** Soft warnings that may indicate misconfiguration. */
  warnings: Array<{ field: string; message: string }>;
}

/** Result of runtime context validation. */
export interface RuntimeContextValidationResult {
  /** Whether the context is valid (no null, undefined, or empty fields). */
  valid: boolean;
  /** Whether the context is fully JSON-serializable. */
  serializable: boolean;
  /** Field paths that are null. */
  nullFields: string[];
  /** Field paths that are undefined. */
  undefinedFields: string[];
  /** Field paths that are empty strings. */
  emptyFields: string[];
  /** Field paths that contain non-serializable values (functions, symbols, etc.). */
  nonSerializableFields: string[];
}

/** Parameter definition from agentConfig.pluginParameters in package.json. */
export interface PluginParamInfo {
  key: string;
  required: boolean;
  sensitive: boolean;
  type: string;
  description: string;
  default?: string;
}

// ---------------------------------------------------------------------------
// API key prefix patterns for format validation
// ---------------------------------------------------------------------------

const KEY_PREFIX_HINTS: Readonly<
  Record<string, { prefix: string; label: string }>
> = {
  ANTHROPIC_API_KEY: { prefix: "sk-ant-", label: "Anthropic" },
  OPENAI_API_KEY: { prefix: "sk-", label: "OpenAI" },
  GROQ_API_KEY: { prefix: "gsk_", label: "Groq" },
  XAI_API_KEY: { prefix: "xai-", label: "xAI" },
  OPENROUTER_API_KEY: { prefix: "sk-or-", label: "OpenRouter" },
};

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * Validate a plugin's configuration.
 *
 * Checks all required parameters (from the plugin's package.json metadata)
 * and applies format-specific warnings for known API key patterns.
 *
 * @param pluginId - The plugin identifier (e.g. "anthropic", "discord")
 * @param category - Plugin category
 * @param envKey - Primary environment variable key (legacy, used as fallback)
 * @param configKeys - All known config key names for this plugin
 * @param providedConfig - Config values being set (for PUT validation)
 * @param paramDefs - Full parameter definitions with required/sensitive metadata
 */
export function validatePluginConfig(
  _pluginId: string,
  _category: string,
  envKey: string | null,
  configKeys: string[],
  providedConfig?: Record<string, string>,
  paramDefs?: PluginParamInfo[],
): PluginValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  const warnings: Array<{ field: string; message: string }> = [];
  const allowedConfigKeys = new Set(configKeys);
  const canonicalKeyByNormalized = new Map<string, string>(
    configKeys.map((key) => [key.trim().toUpperCase(), key]),
  );

  if (providedConfig) {
    for (const key of Object.keys(providedConfig)) {
      if (allowedConfigKeys.has(key)) continue;

      const canonical = canonicalKeyByNormalized.get(key.trim().toUpperCase());
      if (canonical) {
        errors.push({
          field: key,
          message: `${key} does not match declared config key casing; use ${canonical}`,
        });
        continue;
      }

      errors.push({
        field: key,
        message: `${key} is not a declared config key for this plugin`,
      });
    }
  }

  // ── Check all required parameters ─────────────────────────────────────
  if (paramDefs && paramDefs.length > 0) {
    for (const param of paramDefs) {
      if (!param.required) continue;

      // Value source: provided config > process.env > undefined
      const value = providedConfig?.[param.key] ?? process.env[param.key];

      if (!value || !value.trim()) {
        // Required param with a default is a warning, not an error
        if (param.default) {
          warnings.push({
            field: param.key,
            message: `${param.key} is not set (will use default: ${param.default})`,
          });
        } else {
          errors.push({
            field: param.key,
            message: `${param.key} is required but not set`,
          });
        }
        continue;
      }

      // Format validation for known key patterns
      const hint = KEY_PREFIX_HINTS[param.key];
      if (hint && !value.startsWith(hint.prefix)) {
        warnings.push({
          field: param.key,
          message: `${hint.label} key should start with "${hint.prefix}" — the current value may be invalid`,
        });
      }

      // Length sanity check for sensitive keys (API keys / tokens)
      if (param.sensitive && value.trim().length < 10) {
        warnings.push({
          field: param.key,
          message: `${param.key} looks too short (${value.trim().length} chars)`,
        });
      }
    }
  } else if (envKey) {
    // Fallback: no param definitions, but we know the primary env key
    const currentValue = providedConfig?.[envKey] ?? process.env[envKey];
    if (!currentValue || !currentValue.trim()) {
      errors.push({
        field: envKey,
        message: `${envKey} is required but not set`,
      });
    } else {
      const hint = KEY_PREFIX_HINTS[envKey];
      if (hint && !currentValue.startsWith(hint.prefix)) {
        warnings.push({
          field: envKey,
          message: `${hint.label} key should start with "${hint.prefix}" — the current value may be invalid`,
        });
      }

      // Length sanity check for keys/tokens that look suspiciously short
      if (currentValue.trim().length < 10) {
        warnings.push({
          field: envKey,
          message: `${envKey} looks too short (${currentValue.trim().length} chars)`,
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

// ---------------------------------------------------------------------------
// Runtime context validation
// ---------------------------------------------------------------------------

/**
 * Validate a runtime context object for null, undefined, empty, and
 * non-serializable fields.
 *
 * Used after provider + plugin resolution to detect and surface invalid
 * or malformed context early — before it reaches the agent runtime.
 *
 * @param context - The context object to validate.
 * @param maxDepth - Maximum nesting depth to inspect (default: 5).
 */
export function validateRuntimeContext(
  context: Record<string, unknown>,
  maxDepth: number = 5,
): RuntimeContextValidationResult {
  const nullFields: string[] = [];
  const undefinedFields: string[] = [];
  const emptyFields: string[] = [];
  const nonSerializableFields: string[] = [];

  function walk(
    obj: Record<string, unknown>,
    prefix: string,
    depth: number,
  ): void {
    if (depth > maxDepth) return;

    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (value === null) {
        nullFields.push(path);
        continue;
      }

      if (value === undefined) {
        undefinedFields.push(path);
        continue;
      }

      if (typeof value === "string" && value.trim() === "") {
        emptyFields.push(path);
        continue;
      }

      // Check for non-serializable values
      if (typeof value === "function") {
        nonSerializableFields.push(path);
        continue;
      }

      if (typeof value === "symbol") {
        nonSerializableFields.push(path);
        continue;
      }

      if (typeof value === "bigint") {
        nonSerializableFields.push(path);
        continue;
      }

      // Recurse into plain objects
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        !(value instanceof RegExp)
      ) {
        walk(value as Record<string, unknown>, path, depth + 1);
      }
    }
  }

  walk(context, "", 0);

  // Check overall serialization
  let serializable = true;
  if (nonSerializableFields.length > 0) {
    serializable = false;
  } else {
    try {
      JSON.stringify(context);
    } catch {
      serializable = false;
    }
  }

  const valid =
    nullFields.length === 0 &&
    undefinedFields.length === 0 &&
    emptyFields.length === 0;

  return {
    valid,
    serializable,
    nullFields,
    undefinedFields,
    emptyFields,
    nonSerializableFields,
  };
}

// ---------------------------------------------------------------------------
// Plugin context debug logging
// ---------------------------------------------------------------------------

/**
 * Log the full resolved plugin/provider context for debugging.
 *
 * Prints a structured summary of all loaded plugins, providers,
 * and any validation issues detected in the context.
 *
 * @param plugins - Array of resolved plugin names.
 * @param providers - Array of resolved provider names.
 * @param context - The runtime context object to inspect.
 * @param log - Logger function (defaults to console.debug).
 */
export function debugLogResolvedContext(
  plugins: string[],
  providers: string[],
  context: Record<string, unknown>,
  log: (msg: string) => void = console.debug,
): void {
  log("[milady:debug] ══════ Resolved Plugin/Provider Context ══════");
  log(`[milady:debug] Plugins loaded (${plugins.length}):`);
  for (const name of plugins) {
    log(`[milady:debug]   • ${name}`);
  }
  log(`[milady:debug] Providers loaded (${providers.length}):`);
  for (const name of providers) {
    log(`[milady:debug]   • ${name}`);
  }

  const validation = validateRuntimeContext(context);
  if (validation.valid && validation.serializable) {
    log(
      "[milady:debug] Context validation: ✓ PASS (all fields valid, serializable)",
    );
  } else {
    log("[milady:debug] Context validation: ✗ ISSUES DETECTED");
    if (validation.nullFields.length > 0) {
      log(`[milady:debug]   null fields: ${validation.nullFields.join(", ")}`);
    }
    if (validation.undefinedFields.length > 0) {
      log(
        `[milady:debug]   undefined fields: ${validation.undefinedFields.join(", ")}`,
      );
    }
    if (validation.emptyFields.length > 0) {
      log(
        `[milady:debug]   empty fields: ${validation.emptyFields.join(", ")}`,
      );
    }
    if (validation.nonSerializableFields.length > 0) {
      log(
        `[milady:debug]   non-serializable fields: ${validation.nonSerializableFields.join(", ")}`,
      );
    }
  }
  log("[milady:debug] ══════════════════════════════════════════════");
}

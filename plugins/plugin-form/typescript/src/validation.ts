/**
 * @module validation
 * @description Field validation utilities for the Form Plugin
 *
 * ## Design Rationale
 *
 * Validation happens at two points in the form lifecycle:
 *
 * 1. **At Extraction**: When the LLM extracts a value from user message,
 *    we immediately validate it. Invalid values get status 'invalid' and
 *    the agent asks again. This provides instant feedback.
 *
 * 2. **At Submission**: Final validation before submission ensures no
 *    invalid values slipped through. This is the safety net.
 *
 * ## Type Handler Registry (Legacy) vs ControlType
 *
 * There are two ways to register custom types:
 *
 * 1. **TypeHandler (Legacy)**: Simple validate/parse/format functions.
 *    Registered via registerTypeHandler(). Still supported for backwards
 *    compatibility.
 *
 * 2. **ControlType (New)**: Full widget system with subcontrols and
 *    external activation. Registered via FormService.registerControlType().
 *    Use this for new code.
 *
 * This validation module still uses TypeHandler for backwards compatibility.
 * The FormService.getControlType() method should be preferred for new code.
 *
 * ## Custom Type Examples
 *
 * - Blockchain addresses (Solana, EVM)
 * - Phone numbers (with country-specific rules)
 * - Custom business identifiers (order numbers, employee IDs)
 *
 * Custom handlers are checked FIRST, before built-in type validation.
 * This allows overriding built-in types if needed.
 *
 * ## Why String-Based Types
 *
 * Form control types are strings, not enums, because:
 * - Plugins can add new types without modifying core
 * - Type handlers provide runtime extensibility
 * - No need to maintain exhaustive type lists
 */

import type { JsonValue } from "@elizaos/core";
import type { FormControl, TypeHandler } from "./types";

/**
 * Validation result.
 *
 * WHY simple structure:
 * - Just need to know valid/invalid
 * - Error message for user feedback
 * - Easy to compose multiple validations
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ============================================================================
// TYPE HANDLER REGISTRY
// ============================================================================

/**
 * Global registry for custom type handlers.
 *
 * WHY global Map:
 * - Type handlers are stateless
 * - One handler per type is sufficient
 * - Easy to mock in tests (clearTypeHandlers)
 */
const typeHandlers: Map<string, TypeHandler> = new Map();

/**
 * Register a custom type handler.
 *
 * WHY this API:
 * - Simple key-value registration
 * - Called at plugin initialization
 * - Overwrites existing handlers (allows hot-reload)
 *
 * @example
 * ```typescript
 * registerTypeHandler('solana_address', {
 *   validate: (value) => {
 *     const valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value));
 *     return { valid, error: valid ? undefined : 'Invalid Solana address' };
 *   },
 *   extractionPrompt: 'a Solana wallet address (Base58 encoded)',
 * });
 * ```
 */
export function registerTypeHandler(type: string, handler: TypeHandler): void {
  typeHandlers.set(type, handler);
}

/**
 * Get a type handler.
 *
 * @returns The handler or undefined if not registered
 */
export function getTypeHandler(type: string): TypeHandler | undefined {
  return typeHandlers.get(type);
}

/**
 * Clear all type handlers.
 *
 * WHY this exists:
 * - Test isolation
 * - Hot-reload scenarios
 * - Should not be called in production
 */
export function clearTypeHandlers(): void {
  typeHandlers.clear();
}

// ============================================================================
// FIELD VALIDATION
// ============================================================================

/**
 * Validate a value against a control's validation rules.
 *
 * Validation order (first failure returns):
 * 1. Required check
 * 2. Custom type handler (if registered)
 * 3. Built-in type validation
 * 4. Pattern, min/max, etc.
 *
 * WHY this order:
 * - Required is fastest check
 * - Custom handlers may have special logic
 * - Built-in types provide fallback
 * - Pattern/limits are additional constraints
 *
 * @param value - The value to validate
 * @param control - The field definition with validation rules
 * @returns Validation result with error message if invalid
 */
export function validateField(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  // Check required first - fastest check
  if (control.required) {
    if (value === undefined || value === null || value === "") {
      return {
        valid: false,
        error: `${control.label || control.key} is required`,
      };
    }
  }

  // Empty optional fields are valid
  // WHY: No need to validate undefined/null/empty for optional fields
  if (value === undefined || value === null || value === "") {
    return { valid: true };
  }

  // Check custom type handler first
  // WHY: Allows overriding built-in types or adding new ones
  const handler = typeHandlers.get(control.type);
  if (handler?.validate) {
    const result = handler.validate(value, control);
    if (!result.valid) {
      return result;
    }
  }

  // Type-specific validation
  // WHY switch: Clear separation of validation logic per type
  switch (control.type) {
    case "email":
      return validateEmail(value, control);
    case "number":
      return validateNumber(value, control);
    case "boolean":
      return validateBoolean(value, control);
    case "date":
      return validateDate(value, control);
    case "select":
      return validateSelect(value, control);
    case "file":
      return validateFile(value, control);
    case "text":
    default:
      // Default to text validation for unknown types
      // WHY: Text validation handles pattern, length - applicable to most types
      return validateText(value, control);
  }
}

/**
 * Validate text field.
 *
 * Applies: pattern, minLength, maxLength, enum
 */
function validateText(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  const strValue = String(value);

  // Pattern validation
  // WHY regex: Flexible, powerful, user-defined patterns
  if (control.pattern) {
    const regex = new RegExp(control.pattern);
    if (!regex.test(strValue)) {
      return {
        valid: false,
        error: `${control.label || control.key} has invalid format`,
      };
    }
  }

  // Length validation
  // WHY separate minLength/maxLength: min/max used for numeric values too
  if (control.minLength !== undefined && strValue.length < control.minLength) {
    return {
      valid: false,
      error: `${control.label || control.key} must be at least ${control.minLength} characters`,
    };
  }

  if (control.maxLength !== undefined && strValue.length > control.maxLength) {
    return {
      valid: false,
      error: `${control.label || control.key} must be at most ${control.maxLength} characters`,
    };
  }

  // Enum validation
  // WHY enum: Simple allowed-values without full select options
  if (control.enum && control.enum.length > 0) {
    if (!control.enum.includes(strValue)) {
      return {
        valid: false,
        error: `${control.label || control.key} must be one of: ${control.enum.join(", ")}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate email field.
 *
 * WHY simple regex:
 * - Complex RFC 5322 regex is overkill and often wrong
 * - This catches most typos (missing @, missing domain)
 * - Further validation via confirmation email
 */
function validateEmail(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  const strValue = String(value);

  // Basic email regex - intentionally simple
  // WHY: More complex patterns have edge cases; simple pattern catches most errors
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(strValue)) {
    return {
      valid: false,
      error: `${control.label || control.key} must be a valid email address`,
    };
  }

  // Also apply text validation (pattern, length)
  return validateText(value, control);
}

/**
 * Validate number field.
 *
 * Applies: min, max (as numeric values, not length)
 */
function validateNumber(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  // Parse number, handling commas and currency symbols
  // WHY: Users type "1,234" or "$50" and expect it to work
  const numValue =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(/[,$]/g, ""));

  if (isNaN(numValue)) {
    return {
      valid: false,
      error: `${control.label || control.key} must be a number`,
    };
  }

  // Min/max validation
  if (control.min !== undefined && numValue < control.min) {
    return {
      valid: false,
      error: `${control.label || control.key} must be at least ${control.min}`,
    };
  }

  if (control.max !== undefined && numValue > control.max) {
    return {
      valid: false,
      error: `${control.label || control.key} must be at most ${control.max}`,
    };
  }

  return { valid: true };
}

/**
 * Validate boolean field.
 *
 * WHY accept many formats:
 * - Users say "yes", "no", "true", "false", "1", "0"
 * - Agent might extract any of these
 * - All should be valid booleans
 */
function validateBoolean(
  value: JsonValue,
  _control: FormControl,
): ValidationResult {
  if (typeof value === "boolean") {
    return { valid: true };
  }

  // Accept common boolean-like strings
  const strValue = String(value).toLowerCase();
  const truthy = ["true", "yes", "1", "on"];
  const falsy = ["false", "no", "0", "off"];

  if (truthy.includes(strValue) || falsy.includes(strValue)) {
    return { valid: true };
  }

  return { valid: false, error: "Must be true or false" };
}

/**
 * Validate date field.
 *
 * WHY flexible parsing:
 * - Users say "tomorrow", "next Monday", "12/25/2024"
 * - LLM should normalize to parseable format
 * - We accept anything Date() can parse
 */
function validateDate(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  let dateValue: Date;

  if (value instanceof Date) {
    dateValue = value;
  } else if (typeof value === "string" || typeof value === "number") {
    dateValue = new Date(value);
  } else {
    return {
      valid: false,
      error: `${control.label || control.key} must be a valid date`,
    };
  }

  // Invalid Date check
  if (isNaN(dateValue.getTime())) {
    return {
      valid: false,
      error: `${control.label || control.key} must be a valid date`,
    };
  }

  // Min/max as timestamps
  // WHY: Form definition can set date ranges (e.g., future dates only)
  if (control.min !== undefined && dateValue.getTime() < control.min) {
    return {
      valid: false,
      error: `${control.label || control.key} is too early`,
    };
  }

  if (control.max !== undefined && dateValue.getTime() > control.max) {
    return {
      valid: false,
      error: `${control.label || control.key} is too late`,
    };
  }

  return { valid: true };
}

/**
 * Validate select field.
 *
 * WHY strict validation:
 * - Select has defined options
 * - Invalid selections are likely extraction errors
 * - Should reject and re-ask rather than accept garbage
 */
function validateSelect(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  if (!control.options || control.options.length === 0) {
    // No options defined - treat as text
    return { valid: true };
  }

  const strValue = String(value);
  const validValues = control.options.map((opt) => opt.value);

  if (!validValues.includes(strValue)) {
    return {
      valid: false,
      error: `${control.label || control.key} must be one of the available options`,
    };
  }

  return { valid: true };
}

/**
 * Validate file field (validates metadata, not content).
 *
 * WHY metadata-only:
 * - Actual file content is handled elsewhere
 * - This validates the metadata (size, type)
 * - Runs during session, not file upload
 */
function validateFile(
  value: JsonValue,
  control: FormControl,
): ValidationResult {
  if (!control.file) {
    return { valid: true };
  }

  // Value should be an array of file metadata
  const files = Array.isArray(value) ? value : [value];

  // Check max files
  if (control.file.maxFiles && files.length > control.file.maxFiles) {
    return {
      valid: false,
      error: `Maximum ${control.file.maxFiles} files allowed`,
    };
  }

  for (const file of files) {
    if (!file || typeof file !== "object") continue;

    const fileObj = file as { size?: number; mimeType?: string };

    // Check file size
    if (
      control.file.maxSize &&
      fileObj.size &&
      fileObj.size > control.file.maxSize
    ) {
      return {
        valid: false,
        error: `File size exceeds maximum of ${formatBytes(control.file.maxSize)}`,
      };
    }

    // Check accepted MIME types
    if (control.file.accept && fileObj.mimeType) {
      const accepted = control.file.accept.some((pattern) =>
        matchesMimeType(fileObj.mimeType!, pattern),
      );
      if (!accepted) {
        return {
          valid: false,
          error: `File type ${fileObj.mimeType} is not accepted`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Check if a MIME type matches a pattern.
 *
 * Supports:
 * - Exact match: "image/png"
 * - Wildcard: "image/*"
 * - Universal: "*\/*"
 *
 * @example
 * matchesMimeType('image/png', 'image/*') // true
 * matchesMimeType('application/pdf', 'image/*') // false
 */
export function matchesMimeType(mimeType: string, pattern: string): boolean {
  if (pattern === "*/*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // "image/" from "image/*"
    return mimeType.startsWith(prefix);
  }
  return mimeType === pattern;
}

/**
 * Format bytes to human-readable string.
 *
 * @example formatBytes(1024) // "1.0 KB"
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ============================================================================
// VALUE PARSING
// ============================================================================

/**
 * Parse a string value to the appropriate type based on control type.
 *
 * WHY parsing:
 * - LLM extraction returns strings
 * - We need proper types for validation and storage
 * - Custom handlers can define custom parsing
 *
 * @param value - String value from extraction
 * @param control - Field definition to determine type
 * @returns Parsed value of appropriate type
 */
export function parseValue(value: string, control: FormControl): JsonValue {
  // Check for custom type handler
  const handler = typeHandlers.get(control.type);
  if (handler?.parse) {
    return handler.parse(value);
  }

  switch (control.type) {
    case "number":
      // Remove formatting characters
      // WHY: Users type "1,234.56" or "$50.00"
      return parseFloat(value.replace(/[,$]/g, ""));

    case "boolean": {
      const lower = value.toLowerCase();
      return ["true", "yes", "1", "on"].includes(lower);
    }

    case "date": {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : value;
    }

    case "text":
    case "email":
    case "select":
    default:
      // Keep as string for text-like types
      return value;
  }
}

// ============================================================================
// VALUE FORMATTING
// ============================================================================

/**
 * Format a value for display.
 *
 * WHY formatting:
 * - Numbers should have locale formatting
 * - Booleans should be "Yes"/"No" not "true"/"false"
 * - Sensitive values should be masked
 * - Select values should show label not value
 *
 * @param value - The value to format
 * @param control - Field definition with display hints
 * @returns Human-readable string representation
 */
export function formatValue(value: JsonValue, control: FormControl): string {
  if (value === undefined || value === null) return "";

  // Check for custom type handler
  const handler = typeHandlers.get(control.type);
  if (handler?.format) {
    return handler.format(value);
  }

  // Sensitive fields should be masked
  // WHY: Passwords, tokens shouldn't be echoed back to user
  if (control.sensitive) {
    const strVal = String(value);
    if (strVal.length > 8) {
      return `${strVal.slice(0, 4)}...${strVal.slice(-4)}`;
    }
    return "****";
  }

  switch (control.type) {
    case "number":
      // Use locale formatting for numbers
      return typeof value === "number" ? value.toLocaleString() : String(value);

    case "boolean":
      // Human-friendly boolean display
      return value ? "Yes" : "No";

    case "date":
      // Locale-appropriate date format
      return value instanceof Date ? value.toLocaleDateString() : String(value);

    case "select":
      // Show option label instead of value
      // WHY: User sees "United States" not "US"
      if (control.options) {
        const option = control.options.find(
          (opt) => opt.value === String(value),
        );
        if (option) return option.label;
      }
      return String(value);

    case "file":
      // Show file names
      if (Array.isArray(value)) {
        return value
          .map((f) => (f as { name?: string }).name || "file")
          .join(", ");
      }
      return (value as { name?: string }).name || "file";

    default:
      return String(value);
  }
}

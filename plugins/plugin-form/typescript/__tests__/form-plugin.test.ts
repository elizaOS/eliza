/**
 * Comprehensive test suite for plugin-form modules.
 *
 * Covers: validation, intent, ttl, defaults, builder, template, builtins.
 * Runner: bun test (Jest-compatible API via bun:test)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { UUID } from "@elizaos/core";

// ── Source module imports ────────────────────────────────────────────────────


import { C, ControlBuilder, Form, FormBuilder } from "../src/builder.ts";
import {
  BUILTIN_TYPE_MAP,
  BUILTIN_TYPES,
  getBuiltinType,
  isBuiltinType,
  registerBuiltinTypes,
} from "../src/builtins.ts";
import { applyControlDefaults, applyFormDefaults, prettify } from "../src/defaults.ts";
import {
  hasDataToExtract,
  isLifecycleIntent,
  isUXIntent,
  quickIntentDetect,
} from "../src/intent.ts";
import {
  buildTemplateValues,
  renderTemplate,
  resolveControlTemplates,
} from "../src/template.ts";
import {
  calculateTTL,
  formatEffort,
  formatTimeRemaining,
  isExpired,
  isExpiringSoon,
  shouldConfirmCancel,
  shouldNudge,
} from "../src/ttl.ts";
import type {
  ControlType,
  FieldState,
  FormControl,
  FormDefinition,
  FormIntent,
  FormSession,
  SessionEffort,
} from "../src/types.ts";
import {
  clearTypeHandlers,
  formatValue,
  getTypeHandler,
  matchesMimeType,
  parseValue,
  registerTypeHandler,
  validateField,
} from "../src/validation.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal FormControl with sensible defaults, overridable. */
function makeControl(overrides: Partial<FormControl> = {}): FormControl {
  return {
    key: "test_field",
    label: "Test Field",
    type: "text",
    ...overrides,
  };
}

/** Build a SessionEffort with sensible defaults, overridable. */
function makeEffort(overrides: Partial<SessionEffort> = {}): SessionEffort {
  const now = Date.now();
  return {
    interactionCount: 1,
    timeSpentMs: 0,
    firstInteractionAt: now,
    lastInteractionAt: now,
    ...overrides,
  };
}

/** Build a minimal FormSession with sensible defaults, overridable. */
function makeSession(overrides: Partial<FormSession> = {}): FormSession {
  const now = Date.now();
  return {
    id: "session-1",
    formId: "form-1",
    entityId: "00000000-0000-0000-0000-000000000001" as UUID,
    roomId: "00000000-0000-0000-0000-000000000002" as UUID,
    status: "active",
    fields: {},
    history: [],
    effort: makeEffort(),
    expiresAt: now + 14 * MS_PER_DAY,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Build a minimal FormDefinition with sensible defaults, overridable. */
function makeForm(overrides: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: "form-1",
    name: "Test Form",
    controls: [],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. VALIDATION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Validation Module", () => {
  // Clean the type handler registry after every test so custom handlers
  // registered in one test don't leak into another.
  afterEach(() => {
    clearTypeHandlers();
  });

  // ── validateField ────────────────────────────────────────────────────────

  describe("validateField", () => {
    // ── Required field checks ──────────────────────────────────────────────

    describe("required field checks", () => {
      const requiredControl = makeControl({ required: true });

      it("rejects null for a required field", () => {
        // Required fields must have a non-empty value
        const result = validateField(null, requiredControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("is required");
      });

      it("rejects undefined for a required field", () => {
        const result = validateField(undefined as never, requiredControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("is required");
      });

      it("rejects empty string for a required field", () => {
        const result = validateField("", requiredControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("is required");
      });

      it("includes the field label in the error message", () => {
        const ctrl = makeControl({ required: true, label: "Email Address" });
        const result = validateField(null, ctrl);
        expect(result.error).toContain("Email Address");
      });

      it("falls back to key when label is empty", () => {
        const ctrl = makeControl({ required: true, label: "", key: "email" });
        const result = validateField(null, ctrl);
        expect(result.error).toContain("email");
      });
    });

    // ── Optional field checks ──────────────────────────────────────────────

    describe("optional field checks", () => {
      const optionalControl = makeControl({ required: false });

      it("accepts null for an optional field", () => {
        // Optional fields should pass when empty
        const result = validateField(null, optionalControl);
        expect(result.valid).toBe(true);
      });

      it("accepts undefined for an optional field", () => {
        const result = validateField(undefined as never, optionalControl);
        expect(result.valid).toBe(true);
      });

      it("accepts empty string for an optional field", () => {
        const result = validateField("", optionalControl);
        expect(result.valid).toBe(true);
      });
    });

    // ── Email validation ───────────────────────────────────────────────────

    describe("email validation", () => {
      const emailControl = makeControl({ type: "email", key: "email", label: "Email" });

      it("accepts a valid email address", () => {
        expect(validateField("user@example.com", emailControl).valid).toBe(true);
      });

      it("accepts an email with subdomains", () => {
        expect(validateField("user@mail.example.co.uk", emailControl).valid).toBe(true);
      });

      it("accepts an email with plus addressing", () => {
        expect(validateField("user+tag@example.com", emailControl).valid).toBe(true);
      });

      it("rejects an email without @", () => {
        const result = validateField("userexample.com", emailControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("valid email");
      });

      it("rejects an email without a domain", () => {
        const result = validateField("user@", emailControl);
        expect(result.valid).toBe(false);
      });

      it("rejects an email without TLD", () => {
        const result = validateField("user@example", emailControl);
        expect(result.valid).toBe(false);
      });

      it("rejects an email with spaces", () => {
        const result = validateField("user @example.com", emailControl);
        expect(result.valid).toBe(false);
      });

      it("applies text validation rules (pattern) on top of email check", () => {
        // Email validation also chains into validateText for pattern/length
        const ctrl = makeControl({ type: "email", pattern: "^.*@company\\.com$" });
        expect(validateField("user@company.com", ctrl).valid).toBe(true);
        expect(validateField("user@other.com", ctrl).valid).toBe(false);
      });
    });

    // ── Number validation ──────────────────────────────────────────────────

    describe("number validation", () => {
      const numControl = makeControl({ type: "number", label: "Amount" });

      it("accepts an integer", () => {
        expect(validateField(42, numControl).valid).toBe(true);
      });

      it("accepts a decimal number", () => {
        expect(validateField(3.14, numControl).valid).toBe(true);
      });

      it("accepts zero", () => {
        expect(validateField(0, numControl).valid).toBe(true);
      });

      it("accepts a numeric string", () => {
        expect(validateField("99.5", numControl).valid).toBe(true);
      });

      it("accepts a string with commas (parsed during validation)", () => {
        // Validation strips commas and dollar signs before parsing
        expect(validateField("1,234", numControl).valid).toBe(true);
      });

      it("accepts a string with a dollar sign", () => {
        expect(validateField("$50", numControl).valid).toBe(true);
      });

      it("rejects NaN values", () => {
        const result = validateField("not-a-number", numControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("must be a number");
      });

      it("rejects a value below min", () => {
        const ctrl = makeControl({ type: "number", min: 10 });
        const result = validateField(5, ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("at least 10");
      });

      it("rejects a value above max", () => {
        const ctrl = makeControl({ type: "number", max: 100 });
        const result = validateField(150, ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("at most 100");
      });

      it("accepts a value exactly at min bound", () => {
        const ctrl = makeControl({ type: "number", min: 10 });
        expect(validateField(10, ctrl).valid).toBe(true);
      });

      it("accepts a value exactly at max bound", () => {
        const ctrl = makeControl({ type: "number", max: 100 });
        expect(validateField(100, ctrl).valid).toBe(true);
      });

      it("accepts a negative number within range", () => {
        const ctrl = makeControl({ type: "number", min: -100, max: 0 });
        expect(validateField(-50, ctrl).valid).toBe(true);
      });
    });

    // ── Boolean validation ─────────────────────────────────────────────────

    describe("boolean validation", () => {
      const boolControl = makeControl({ type: "boolean" });

      it("accepts native true", () => {
        expect(validateField(true, boolControl).valid).toBe(true);
      });

      it("accepts native false", () => {
        expect(validateField(false, boolControl).valid).toBe(true);
      });

      it.each(["true", "false", "yes", "no", "1", "0", "on", "off"])(
        'accepts boolean-like string "%s"',
        (val) => {
          expect(validateField(val, boolControl).valid).toBe(true);
        },
      );

      it("is case-insensitive for boolean strings", () => {
        expect(validateField("YES", boolControl).valid).toBe(true);
        expect(validateField("True", boolControl).valid).toBe(true);
        expect(validateField("OFF", boolControl).valid).toBe(true);
      });

      it("rejects invalid boolean-like strings", () => {
        const result = validateField("maybe", boolControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("true or false");
      });

      it("rejects a random number", () => {
        // Numbers other than "1" and "0" as strings should fail
        const result = validateField("42", boolControl);
        expect(result.valid).toBe(false);
      });
    });

    // ── Date validation ────────────────────────────────────────────────────

    describe("date validation", () => {
      const dateControl = makeControl({ type: "date", label: "Start Date" });

      it("accepts a valid ISO date string", () => {
        expect(validateField("2024-06-15", dateControl).valid).toBe(true);
      });

      it("accepts a valid Date-parseable timestamp", () => {
        // Date constructor can parse timestamps
        expect(validateField(1700000000000, dateControl).valid).toBe(true);
      });

      it("rejects an invalid date string", () => {
        const result = validateField("not-a-date", dateControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("valid date");
      });

      it("rejects an object that is not a Date", () => {
        const result = validateField({ foo: "bar" }, dateControl);
        expect(result.valid).toBe(false);
      });

      it("enforces min date (timestamp)", () => {
        // min is used as a timestamp for date types
        const futureTimestamp = new Date("2025-01-01").getTime();
        const ctrl = makeControl({ type: "date", min: futureTimestamp });
        const result = validateField("2020-01-01", ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("too early");
      });

      it("enforces max date (timestamp)", () => {
        const pastTimestamp = new Date("2020-01-01").getTime();
        const ctrl = makeControl({ type: "date", max: pastTimestamp });
        const result = validateField("2025-06-15", ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("too late");
      });

      it("accepts a date within range", () => {
        const ctrl = makeControl({
          type: "date",
          min: new Date("2024-01-01").getTime(),
          max: new Date("2024-12-31").getTime(),
        });
        expect(validateField("2024-06-15", ctrl).valid).toBe(true);
      });
    });

    // ── Select validation ──────────────────────────────────────────────────

    describe("select validation", () => {
      const selectControl = makeControl({
        type: "select",
        label: "Country",
        options: [
          { value: "US", label: "United States" },
          { value: "CA", label: "Canada" },
          { value: "MX", label: "Mexico" },
        ],
      });

      it("accepts a valid option value", () => {
        expect(validateField("US", selectControl).valid).toBe(true);
      });

      it("rejects an invalid option value", () => {
        const result = validateField("XX", selectControl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("available options");
      });

      it("is case-sensitive for option values", () => {
        // "us" !== "US" — select values are exact match
        const result = validateField("us", selectControl);
        expect(result.valid).toBe(false);
      });

      it("treats as text (valid) when no options are defined", () => {
        // When options array is absent or empty, any value passes
        const ctrl = makeControl({ type: "select" });
        expect(validateField("anything", ctrl).valid).toBe(true);
      });

      it("treats as text when options is empty array", () => {
        const ctrl = makeControl({ type: "select", options: [] });
        expect(validateField("anything", ctrl).valid).toBe(true);
      });
    });

    // ── Text validation ────────────────────────────────────────────────────

    describe("text validation", () => {
      it("validates against a regex pattern", () => {
        const ctrl = makeControl({ pattern: "^[A-Z]{3}$" });
        expect(validateField("ABC", ctrl).valid).toBe(true);
        expect(validateField("abc", ctrl).valid).toBe(false);
        expect(validateField("ABCD", ctrl).valid).toBe(false);
      });

      it("enforces minLength", () => {
        const ctrl = makeControl({ minLength: 5 });
        expect(validateField("abcde", ctrl).valid).toBe(true);
        expect(validateField("abc", ctrl).valid).toBe(false);
      });

      it("enforces maxLength", () => {
        const ctrl = makeControl({ maxLength: 5 });
        expect(validateField("abcde", ctrl).valid).toBe(true);
        expect(validateField("abcdefgh", ctrl).valid).toBe(false);
      });

      it("validates enum values", () => {
        const ctrl = makeControl({ enum: ["small", "medium", "large"] });
        expect(validateField("medium", ctrl).valid).toBe(true);

        const result = validateField("extra-large", ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("must be one of");
      });

      it("applies text validation for unknown types (fallback)", () => {
        // An unregistered type falls through to default text validation
        const ctrl = makeControl({ type: "custom_phone", pattern: "^\\d{10}$" });
        expect(validateField("1234567890", ctrl).valid).toBe(true);
        expect(validateField("short", ctrl).valid).toBe(false);
      });
    });

    // ── File validation ────────────────────────────────────────────────────

    describe("file validation", () => {
      it("passes when no file options are configured", () => {
        const ctrl = makeControl({ type: "file" });
        expect(validateField([{ name: "test.pdf" }], ctrl).valid).toBe(true);
      });

      it("enforces maxFiles limit", () => {
        const ctrl = makeControl({
          type: "file",
          file: { maxFiles: 2 },
        });
        const threeFiles = [
          { name: "a.pdf", size: 100, mimeType: "application/pdf" },
          { name: "b.pdf", size: 100, mimeType: "application/pdf" },
          { name: "c.pdf", size: 100, mimeType: "application/pdf" },
        ];
        const result = validateField(threeFiles, ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Maximum 2 files");
      });

      it("accepts files within maxFiles limit", () => {
        const ctrl = makeControl({
          type: "file",
          file: { maxFiles: 3 },
        });
        const twoFiles = [
          { name: "a.pdf", size: 100, mimeType: "application/pdf" },
          { name: "b.pdf", size: 100, mimeType: "application/pdf" },
        ];
        expect(validateField(twoFiles, ctrl).valid).toBe(true);
      });

      it("enforces maxSize per file", () => {
        const ctrl = makeControl({
          type: "file",
          file: { maxSize: 1024 },
        });
        const oversized = [{ name: "big.bin", size: 2048, mimeType: "application/octet-stream" }];
        const result = validateField(oversized, ctrl);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("exceeds maximum");
      });

      it("enforces accepted MIME types", () => {
        const ctrl = makeControl({
          type: "file",
          file: { accept: ["image/*", "application/pdf"] },
        });
        // Valid MIME type
        expect(
          validateField([{ name: "pic.png", size: 100, mimeType: "image/png" }], ctrl).valid,
        ).toBe(true);
        // Invalid MIME type
        const result = validateField(
          [{ name: "data.csv", size: 100, mimeType: "text/csv" }],
          ctrl,
        );
        expect(result.valid).toBe(false);
        expect(result.error).toContain("not accepted");
      });
    });
  });

  // ── matchesMimeType ──────────────────────────────────────────────────────

  describe("matchesMimeType", () => {
    it("matches exact MIME type", () => {
      expect(matchesMimeType("image/png", "image/png")).toBe(true);
    });

    it("does not match different exact MIME type", () => {
      expect(matchesMimeType("image/png", "image/jpeg")).toBe(false);
    });

    it("matches wildcard subtype (image/*)", () => {
      expect(matchesMimeType("image/png", "image/*")).toBe(true);
      expect(matchesMimeType("image/jpeg", "image/*")).toBe(true);
    });

    it("rejects different primary type with wildcard", () => {
      expect(matchesMimeType("application/pdf", "image/*")).toBe(false);
    });

    it("matches universal wildcard (*/*)", () => {
      expect(matchesMimeType("image/png", "*/*")).toBe(true);
      expect(matchesMimeType("application/json", "*/*")).toBe(true);
      expect(matchesMimeType("text/plain", "*/*")).toBe(true);
    });
  });

  // ── parseValue ───────────────────────────────────────────────────────────

  describe("parseValue", () => {
    it("parses a number string, removing commas", () => {
      const ctrl = makeControl({ type: "number" });
      expect(parseValue("1,234.56", ctrl)).toBe(1234.56);
    });

    it("parses a number string, removing dollar sign", () => {
      const ctrl = makeControl({ type: "number" });
      expect(parseValue("$50", ctrl)).toBe(50);
    });

    it("parses an integer string as number", () => {
      const ctrl = makeControl({ type: "number" });
      expect(parseValue("42", ctrl)).toBe(42);
    });

    it("returns NaN for unparseable number", () => {
      const ctrl = makeControl({ type: "number" });
      expect(Number.isNaN(parseValue("abc", ctrl))).toBe(true);
    });

    it("parses truthy boolean strings to true", () => {
      const ctrl = makeControl({ type: "boolean" });
      expect(parseValue("true", ctrl)).toBe(true);
      expect(parseValue("yes", ctrl)).toBe(true);
      expect(parseValue("1", ctrl)).toBe(true);
      expect(parseValue("on", ctrl)).toBe(true);
    });

    it("parses falsy boolean strings to false", () => {
      const ctrl = makeControl({ type: "boolean" });
      expect(parseValue("false", ctrl)).toBe(false);
      expect(parseValue("no", ctrl)).toBe(false);
      expect(parseValue("0", ctrl)).toBe(false);
      expect(parseValue("off", ctrl)).toBe(false);
    });

    it("is case-insensitive for boolean parsing", () => {
      const ctrl = makeControl({ type: "boolean" });
      expect(parseValue("YES", ctrl)).toBe(true);
      expect(parseValue("FALSE", ctrl)).toBe(false);
    });

    it("parses a date string to ISO format", () => {
      const ctrl = makeControl({ type: "date" });
      const result = parseValue("2024-06-15", ctrl);
      expect(typeof result).toBe("string");
      expect(result).toContain("2024-06-15");
    });

    it("keeps text/email/select values as strings", () => {
      expect(parseValue("hello", makeControl({ type: "text" }))).toBe("hello");
      expect(parseValue("a@b.com", makeControl({ type: "email" }))).toBe("a@b.com");
      expect(parseValue("US", makeControl({ type: "select" }))).toBe("US");
    });

    it("uses custom type handler parse when registered", () => {
      registerTypeHandler("custom_type", {
        parse: (v: string) => v.toUpperCase(),
      });
      const ctrl = makeControl({ type: "custom_type" });
      expect(parseValue("hello", ctrl)).toBe("HELLO");
    });
  });

  // ── formatValue ──────────────────────────────────────────────────────────

  describe("formatValue", () => {
    it("returns empty string for null", () => {
      expect(formatValue(null, makeControl())).toBe("");
    });

    it("returns empty string for undefined", () => {
      expect(formatValue(undefined as never, makeControl())).toBe("");
    });

    it("formats a number with locale string", () => {
      const ctrl = makeControl({ type: "number" });
      const result = formatValue(1234, ctrl);
      // Locale formatting varies, but should contain the digits
      expect(result).toContain("1");
      expect(result).toContain("234");
    });

    it("formats boolean true as 'Yes'", () => {
      const ctrl = makeControl({ type: "boolean" });
      expect(formatValue(true, ctrl)).toBe("Yes");
    });

    it("formats boolean false as 'No'", () => {
      const ctrl = makeControl({ type: "boolean" });
      expect(formatValue(false, ctrl)).toBe("No");
    });

    it("masks sensitive fields longer than 8 characters", () => {
      // Values > 8 chars show first 4 and last 4 with "..." in between
      const ctrl = makeControl({ sensitive: true });
      const result = formatValue("supersecrettoken", ctrl);
      expect(result).toBe("supe...oken");
    });

    it("fully masks sensitive fields of 8 characters or fewer", () => {
      const ctrl = makeControl({ sensitive: true });
      expect(formatValue("short", ctrl)).toBe("****");
      expect(formatValue("12345678", ctrl)).toBe("****");
    });

    it("shows option label for select type", () => {
      const ctrl = makeControl({
        type: "select",
        options: [
          { value: "US", label: "United States" },
          { value: "CA", label: "Canada" },
        ],
      });
      expect(formatValue("US", ctrl)).toBe("United States");
    });

    it("falls back to raw value when select option not found", () => {
      const ctrl = makeControl({
        type: "select",
        options: [{ value: "US", label: "United States" }],
      });
      expect(formatValue("XX", ctrl)).toBe("XX");
    });

    it("formats file array as comma-separated names", () => {
      const ctrl = makeControl({ type: "file" });
      const files = [{ name: "doc.pdf" }, { name: "img.png" }];
      expect(formatValue(files, ctrl)).toBe("doc.pdf, img.png");
    });

    it("formats single file object with its name", () => {
      const ctrl = makeControl({ type: "file" });
      expect(formatValue({ name: "report.xlsx" }, ctrl)).toBe("report.xlsx");
    });

    it("uses custom type handler format when registered", () => {
      registerTypeHandler("currency", {
        format: (v) => `$${Number(v).toFixed(2)}`,
      });
      const ctrl = makeControl({ type: "currency" });
      expect(formatValue(42, ctrl)).toBe("$42.00");
    });
  });

  // ── Type handler registry ────────────────────────────────────────────────

  describe("type handler registry", () => {
    it("registers and retrieves a custom type handler", () => {
      registerTypeHandler("phone", {
        validate: (v) => ({
          valid: /^\d{10}$/.test(String(v)),
          error: "Must be 10 digits",
        }),
      });
      const handler = getTypeHandler("phone");
      expect(handler).toBeDefined();
      expect(handler!.validate).toBeDefined();
    });

    it("returns undefined for unregistered types", () => {
      expect(getTypeHandler("nonexistent")).toBeUndefined();
    });

    it("allows overriding an existing handler", () => {
      registerTypeHandler("phone", {
        validate: () => ({ valid: true }),
      });
      registerTypeHandler("phone", {
        validate: () => ({ valid: false, error: "always fails" }),
      });
      const handler = getTypeHandler("phone");
      const result = handler!.validate!("anything", makeControl());
      expect(result.valid).toBe(false);
    });

    it("clears all handlers", () => {
      registerTypeHandler("a", { validate: () => ({ valid: true }) });
      registerTypeHandler("b", { validate: () => ({ valid: true }) });
      clearTypeHandlers();
      expect(getTypeHandler("a")).toBeUndefined();
      expect(getTypeHandler("b")).toBeUndefined();
    });

    it("custom handler rejection takes priority over built-in validation", () => {
      // Register a handler that always rejects for the "number" type
      registerTypeHandler("number", {
        validate: () => ({ valid: false, error: "Custom rejection" }),
      });
      const ctrl = makeControl({ type: "number" });
      const result = validateField(42, ctrl);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Custom rejection");
    });

    it("built-in validation still runs after custom handler passes", () => {
      // Register a handler that always accepts for the "email" type
      registerTypeHandler("email", {
        validate: () => ({ valid: true }),
      });
      // Built-in email validation should still run and reject bad emails
      const ctrl = makeControl({ type: "email" });
      const result = validateField("not-an-email", ctrl);
      expect(result.valid).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. INTENT DETECTION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Intent Detection Module", () => {
  // ── quickIntentDetect ────────────────────────────────────────────────────

  describe("quickIntentDetect", () => {
    // ── Submit intents ─────────────────────────────────────────────────────

    describe("submit intents", () => {
      it.each([
        "submit",
        "done",
        "finish",
        "send it",
        "that's all",
        "i'm done",
        "complete",
        "all set",
      ])('detects "%s" as submit', (text) => {
        expect(quickIntentDetect(text)).toBe("submit");
      });

      it("is case-insensitive", () => {
        expect(quickIntentDetect("SUBMIT")).toBe("submit");
        expect(quickIntentDetect("Done")).toBe("submit");
      });
    });

    // ── Cancel intents ─────────────────────────────────────────────────────

    describe("cancel intents", () => {
      it.each([
        "cancel",
        "abort",
        "nevermind",
        "never mind",
        "forget it",
        "stop",
        "quit",
        "exit",
      ])('detects "%s" as cancel', (text) => {
        expect(quickIntentDetect(text)).toBe("cancel");
      });
    });

    // ── Stash intents ──────────────────────────────────────────────────────

    describe("stash intents", () => {
      it.each(["save", "save for later", "pause", "later", "hold on", "come back"])(
        'detects "%s" as stash',
        (text) => {
          expect(quickIntentDetect(text)).toBe("stash");
        },
      );

      it('does NOT detect "save and submit" as stash (returns submit)', () => {
        // "submit" keyword is checked before stash, so it matches submit first
        expect(quickIntentDetect("save and submit")).toBe("submit");
      });

      it('does NOT detect "save and send" as stash (excluded)', () => {
        // "save and send" is excluded from stash; but "send it" matches submit
        const result = quickIntentDetect("save and send");
        expect(result).not.toBe("stash");
      });
    });

    // ── Restore intents ────────────────────────────────────────────────────

    describe("restore intents", () => {
      it.each(["resume", "continue", "pick up where", "go back to", "get back to"])(
        'detects "%s" as restore',
        (text) => {
          expect(quickIntentDetect(text)).toBe("restore");
        },
      );

      it('detects "pick up where I left off" as restore', () => {
        expect(quickIntentDetect("pick up where I left off")).toBe("restore");
      });
    });

    // ── Undo intents ───────────────────────────────────────────────────────

    describe("undo intents", () => {
      it.each(["undo", "go back", "wait no", "change that", "oops", "that's wrong"])(
        'detects "%s" as undo',
        (text) => {
          expect(quickIntentDetect(text)).toBe("undo");
        },
      );
    });

    // ── Skip intents ───────────────────────────────────────────────────────

    describe("skip intents", () => {
      it.each(["skip", "pass", "don't know", "next", "don't have"])(
        'detects "%s" as skip',
        (text) => {
          expect(quickIntentDetect(text)).toBe("skip");
        },
      );

      it('does NOT detect "skip to" as skip', () => {
        // "skip to" is navigation, not skipping current field
        expect(quickIntentDetect("skip to")).not.toBe("skip");
      });

      it('does NOT detect "skip to the end" as skip', () => {
        expect(quickIntentDetect("skip to the end")).not.toBe("skip");
      });
    });

    // ── Explain intents ────────────────────────────────────────────────────

    describe("explain intents", () => {
      it('detects standalone "why?" as explain', () => {
        expect(quickIntentDetect("why?")).toBe("explain");
      });

      it('detects standalone "why" (no question mark) as explain', () => {
        expect(quickIntentDetect("why")).toBe("explain");
      });

      it('detects "what\'s that for?" as explain', () => {
        expect(quickIntentDetect("what's that for?")).toBe("explain");
      });

      it('detects "explain" as explain', () => {
        expect(quickIntentDetect("explain")).toBe("explain");
      });

      it('detects "tell me why" as explain (keyword at end)', () => {
        expect(quickIntentDetect("tell me why")).toBe("explain");
      });
    });

    // ── Example intents ────────────────────────────────────────────────────

    describe("example intents", () => {
      it('detects standalone "example?" as example', () => {
        expect(quickIntentDetect("example?")).toBe("example");
      });

      it('detects "like what?" as example', () => {
        expect(quickIntentDetect("like what?")).toBe("example");
      });

      it('detects "show me" as example', () => {
        expect(quickIntentDetect("show me")).toBe("example");
      });

      it('detects standalone "example" (no question mark) as example', () => {
        expect(quickIntentDetect("example")).toBe("example");
      });
    });

    // ── Progress intents ───────────────────────────────────────────────────

    describe("progress intents", () => {
      it.each(["how far", "how many left", "progress", "status"])(
        'detects "%s" as progress',
        (text) => {
          expect(quickIntentDetect(text)).toBe("progress");
        },
      );
    });

    // ── Autofill intents ───────────────────────────────────────────────────

    describe("autofill intents", () => {
      it.each(["same as last time", "like before", "use my usual"])(
        'detects "%s" as autofill',
        (text) => {
          expect(quickIntentDetect(text)).toBe("autofill");
        },
      );
    });

    // ── Edge cases ─────────────────────────────────────────────────────────

    describe("edge cases", () => {
      it("returns null for empty string", () => {
        expect(quickIntentDetect("")).toBeNull();
      });

      it("returns null for single character", () => {
        expect(quickIntentDetect("a")).toBeNull();
      });

      it("returns null when no pattern matches", () => {
        expect(quickIntentDetect("my name is John")).toBeNull();
      });

      it("trims whitespace before matching", () => {
        expect(quickIntentDetect("  submit  ")).toBe("submit");
      });
    });
  });

  // ── isLifecycleIntent ────────────────────────────────────────────────────

  describe("isLifecycleIntent", () => {
    it.each(["submit", "stash", "restore", "cancel"] as FormIntent[])(
      'returns true for lifecycle intent "%s"',
      (intent) => {
        expect(isLifecycleIntent(intent)).toBe(true);
      },
    );

    it.each(["undo", "skip", "explain", "example", "progress", "autofill", "fill_form", "other"] as FormIntent[])(
      'returns false for non-lifecycle intent "%s"',
      (intent) => {
        expect(isLifecycleIntent(intent)).toBe(false);
      },
    );
  });

  // ── isUXIntent ───────────────────────────────────────────────────────────

  describe("isUXIntent", () => {
    it.each(["undo", "skip", "explain", "example", "progress", "autofill"] as FormIntent[])(
      'returns true for UX intent "%s"',
      (intent) => {
        expect(isUXIntent(intent)).toBe(true);
      },
    );

    it.each(["submit", "stash", "restore", "cancel", "fill_form", "other"] as FormIntent[])(
      'returns false for non-UX intent "%s"',
      (intent) => {
        expect(isUXIntent(intent)).toBe(false);
      },
    );
  });

  // ── hasDataToExtract ─────────────────────────────────────────────────────

  describe("hasDataToExtract", () => {
    it("returns true for fill_form intent", () => {
      expect(hasDataToExtract("fill_form")).toBe(true);
    });

    it("returns true for other (unknown) intent", () => {
      expect(hasDataToExtract("other")).toBe(true);
    });

    it.each(["submit", "cancel", "stash", "restore", "undo", "skip", "explain", "example", "progress", "autofill"] as FormIntent[])(
      'returns false for "%s" intent',
      (intent) => {
        expect(hasDataToExtract(intent)).toBe(false);
      },
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. TTL TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("TTL Module", () => {
  // ── calculateTTL ─────────────────────────────────────────────────────────

  describe("calculateTTL", () => {
    it("returns at least minDays when effort is zero", () => {
      // With no effort, TTL should equal the minimum (default 14 days)
      const session = makeSession({ effort: makeEffort({ timeSpentMs: 0 }) });
      const result = calculateTTL(session);
      const expectedMin = 14 * MS_PER_DAY;
      const diff = result - Date.now();
      // Allow small tolerance for execution time
      expect(diff).toBeGreaterThan(expectedMin - 1000);
      expect(diff).toBeLessThan(expectedMin + 1000);
    });

    it("caps at maxDays for very high effort", () => {
      // 300 minutes * 0.5 = 150 days, capped at 90 days
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 300 * MS_PER_MINUTE }),
      });
      const result = calculateTTL(session);
      const expectedMax = 90 * MS_PER_DAY;
      const diff = result - Date.now();
      expect(diff).toBeGreaterThan(expectedMax - 1000);
      expect(diff).toBeLessThan(expectedMax + 1000);
    });

    it("scales linearly with moderate effort", () => {
      // 60 minutes * 0.5 = 30 days (between min=14 and max=90)
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 60 * MS_PER_MINUTE }),
      });
      const result = calculateTTL(session);
      const expected = 30 * MS_PER_DAY;
      const diff = result - Date.now();
      expect(diff).toBeGreaterThan(expected - 1000);
      expect(diff).toBeLessThan(expected + 1000);
    });

    it("uses custom config from form definition", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 0 }),
      });
      const form = makeForm({
        ttl: { minDays: 7, maxDays: 30, effortMultiplier: 1.0 },
      });
      const result = calculateTTL(session, form);
      const expected = 7 * MS_PER_DAY;
      const diff = result - Date.now();
      expect(diff).toBeGreaterThan(expected - 1000);
      expect(diff).toBeLessThan(expected + 1000);
    });

    it("uses custom effortMultiplier", () => {
      // 10 minutes * 2.0 multiplier = 20 days (above default minDays 14)
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 10 * MS_PER_MINUTE }),
      });
      const form = makeForm({ ttl: { effortMultiplier: 2.0 } });
      const result = calculateTTL(session, form);
      const expected = 20 * MS_PER_DAY;
      const diff = result - Date.now();
      expect(diff).toBeGreaterThan(expected - 1000);
      expect(diff).toBeLessThan(expected + 1000);
    });
  });

  // ── shouldNudge ──────────────────────────────────────────────────────────

  describe("shouldNudge", () => {
    it("returns false when nudge is disabled", () => {
      const session = makeSession({
        effort: makeEffort({ lastInteractionAt: Date.now() - 100 * MS_PER_HOUR }),
      });
      const form = makeForm({ nudge: { enabled: false } });
      expect(shouldNudge(session, form)).toBe(false);
    });

    it("returns false when max nudges reached", () => {
      const session = makeSession({
        nudgeCount: 3,
        effort: makeEffort({ lastInteractionAt: Date.now() - 100 * MS_PER_HOUR }),
      });
      expect(shouldNudge(session)).toBe(false);
    });

    it("returns false when interaction is too recent", () => {
      // Last interaction 1 hour ago, threshold is 48 hours
      const session = makeSession({
        effort: makeEffort({ lastInteractionAt: Date.now() - 1 * MS_PER_HOUR }),
      });
      expect(shouldNudge(session)).toBe(false);
    });

    it("returns false when last nudge was less than 24h ago", () => {
      // Inactive long enough, but nudged recently
      const session = makeSession({
        effort: makeEffort({ lastInteractionAt: Date.now() - 100 * MS_PER_HOUR }),
        nudgeCount: 1,
        lastNudgeAt: Date.now() - 12 * MS_PER_HOUR, // 12h ago
      });
      expect(shouldNudge(session)).toBe(false);
    });

    it("returns true when all conditions are met", () => {
      // Inactive for 72 hours, no previous nudges
      const session = makeSession({
        effort: makeEffort({ lastInteractionAt: Date.now() - 72 * MS_PER_HOUR }),
        nudgeCount: 0,
      });
      expect(shouldNudge(session)).toBe(true);
    });

    it("returns true when last nudge was more than 24h ago and under max", () => {
      const session = makeSession({
        effort: makeEffort({ lastInteractionAt: Date.now() - 100 * MS_PER_HOUR }),
        nudgeCount: 1,
        lastNudgeAt: Date.now() - 48 * MS_PER_HOUR, // 48h ago
      });
      expect(shouldNudge(session)).toBe(true);
    });

    it("uses custom afterInactiveHours from form nudge config", () => {
      // Custom: nudge after 12 hours of inactivity
      const session = makeSession({
        effort: makeEffort({ lastInteractionAt: Date.now() - 24 * MS_PER_HOUR }),
      });
      const form = makeForm({ nudge: { afterInactiveHours: 12 } });
      expect(shouldNudge(session, form)).toBe(true);
    });
  });

  // ── isExpiringSoon ───────────────────────────────────────────────────────

  describe("isExpiringSoon", () => {
    it("returns true when session expires within the given window", () => {
      // Expires in 12 hours, check window is 24 hours
      const session = makeSession({ expiresAt: Date.now() + 12 * MS_PER_HOUR });
      expect(isExpiringSoon(session, 24 * MS_PER_HOUR)).toBe(true);
    });

    it("returns false when session expires well outside the window", () => {
      // Expires in 48 hours, check window is 24 hours
      const session = makeSession({ expiresAt: Date.now() + 48 * MS_PER_HOUR });
      expect(isExpiringSoon(session, 24 * MS_PER_HOUR)).toBe(false);
    });

    it("returns true for an already-expired session", () => {
      const session = makeSession({ expiresAt: Date.now() - MS_PER_HOUR });
      expect(isExpiringSoon(session, 24 * MS_PER_HOUR)).toBe(true);
    });
  });

  // ── isExpired ────────────────────────────────────────────────────────────

  describe("isExpired", () => {
    it("returns true for an expired session", () => {
      const session = makeSession({ expiresAt: Date.now() - MS_PER_HOUR });
      expect(isExpired(session)).toBe(true);
    });

    it("returns false for an active session", () => {
      const session = makeSession({ expiresAt: Date.now() + MS_PER_DAY });
      expect(isExpired(session)).toBe(false);
    });

    it("returns true when expiresAt is exactly now (edge case)", () => {
      // expiresAt < Date.now() — if set to now, by the time function runs
      // Date.now() has advanced, so it's expired
      const session = makeSession({ expiresAt: Date.now() - 1 });
      expect(isExpired(session)).toBe(true);
    });
  });

  // ── shouldConfirmCancel ──────────────────────────────────────────────────

  describe("shouldConfirmCancel", () => {
    it("returns true for high effort (> 5 minutes)", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 6 * MS_PER_MINUTE }),
      });
      expect(shouldConfirmCancel(session)).toBe(true);
    });

    it("returns false for low effort (< 5 minutes)", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 2 * MS_PER_MINUTE }),
      });
      expect(shouldConfirmCancel(session)).toBe(false);
    });

    it("returns false for exactly 5 minutes (strict greater-than)", () => {
      // The threshold is strict > 5 minutes, so exactly 5 min returns false
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 5 * MS_PER_MINUTE }),
      });
      expect(shouldConfirmCancel(session)).toBe(false);
    });
  });

  // ── formatTimeRemaining ──────────────────────────────────────────────────

  describe("formatTimeRemaining", () => {
    it('returns "expired" for a past expiration', () => {
      const session = makeSession({ expiresAt: Date.now() - MS_PER_HOUR });
      expect(formatTimeRemaining(session)).toBe("expired");
    });

    it("formats days correctly (plural)", () => {
      const session = makeSession({ expiresAt: Date.now() + 3 * MS_PER_DAY + MS_PER_HOUR });
      expect(formatTimeRemaining(session)).toBe("3 days");
    });

    it("formats singular day", () => {
      const session = makeSession({ expiresAt: Date.now() + 1 * MS_PER_DAY + MS_PER_HOUR });
      expect(formatTimeRemaining(session)).toBe("1 day");
    });

    it("formats hours correctly (plural)", () => {
      const session = makeSession({ expiresAt: Date.now() + 5 * MS_PER_HOUR + MS_PER_MINUTE });
      expect(formatTimeRemaining(session)).toBe("5 hours");
    });

    it("formats singular hour", () => {
      const session = makeSession({ expiresAt: Date.now() + 1 * MS_PER_HOUR + MS_PER_MINUTE });
      expect(formatTimeRemaining(session)).toBe("1 hour");
    });

    it("formats minutes correctly (plural)", () => {
      const session = makeSession({ expiresAt: Date.now() + 45 * MS_PER_MINUTE + 5000 });
      expect(formatTimeRemaining(session)).toBe("45 minutes");
    });

    it("formats singular minute", () => {
      const session = makeSession({ expiresAt: Date.now() + 1 * MS_PER_MINUTE + 5000 });
      expect(formatTimeRemaining(session)).toBe("1 minute");
    });
  });

  // ── formatEffort ─────────────────────────────────────────────────────────

  describe("formatEffort", () => {
    it('returns "just started" for less than 1 minute', () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 30 * 1000 }),
      });
      expect(formatEffort(session)).toBe("just started");
    });

    it("formats minutes (plural)", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 5 * MS_PER_MINUTE }),
      });
      expect(formatEffort(session)).toBe("5 minutes");
    });

    it("formats singular minute", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 1 * MS_PER_MINUTE }),
      });
      expect(formatEffort(session)).toBe("1 minute");
    });

    it("formats exact hours (plural)", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 2 * MS_PER_HOUR }),
      });
      expect(formatEffort(session)).toBe("2 hours");
    });

    it("formats singular hour", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 1 * MS_PER_HOUR }),
      });
      expect(formatEffort(session)).toBe("1 hour");
    });

    it("formats hours and minutes", () => {
      const session = makeSession({
        effort: makeEffort({ timeSpentMs: 1 * MS_PER_HOUR + 30 * MS_PER_MINUTE }),
      });
      expect(formatEffort(session)).toBe("1h 30m");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. DEFAULTS TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Defaults Module", () => {
  // ── prettify ─────────────────────────────────────────────────────────────

  describe("prettify", () => {
    it("converts snake_case to Title Case", () => {
      expect(prettify("first_name")).toBe("First Name");
    });

    it("converts kebab-case to Title Case", () => {
      expect(prettify("email-address")).toBe("Email Address");
    });

    it("capitalizes a single word", () => {
      expect(prettify("email")).toBe("Email");
    });

    it("returns empty string for empty input", () => {
      expect(prettify("")).toBe("");
    });

    it("handles mixed separators", () => {
      expect(prettify("full_name-alt")).toBe("Full Name Alt");
    });
  });

  // ── applyControlDefaults ─────────────────────────────────────────────────

  describe("applyControlDefaults", () => {
    it("fills in label from key when only key is provided", () => {
      const ctrl = applyControlDefaults({ key: "user_email" });
      expect(ctrl.key).toBe("user_email");
      expect(ctrl.label).toBe("User Email");
    });

    it("defaults type to text", () => {
      const ctrl = applyControlDefaults({ key: "name" });
      expect(ctrl.type).toBe("text");
    });

    it("defaults required to false", () => {
      const ctrl = applyControlDefaults({ key: "name" });
      expect(ctrl.required).toBe(false);
    });

    it("defaults confirmThreshold to 0.8", () => {
      const ctrl = applyControlDefaults({ key: "name" });
      expect(ctrl.confirmThreshold).toBe(0.8);
    });

    it("preserves explicitly set values", () => {
      const ctrl = applyControlDefaults({
        key: "email",
        label: "Your Email",
        type: "email",
        required: true,
        confirmThreshold: 0.9,
      });
      expect(ctrl.label).toBe("Your Email");
      expect(ctrl.type).toBe("email");
      expect(ctrl.required).toBe(true);
      expect(ctrl.confirmThreshold).toBe(0.9);
    });

    it("preserves additional properties like pattern and description", () => {
      const ctrl = applyControlDefaults({
        key: "zip",
        pattern: "^\\d{5}$",
        description: "US ZIP code",
      });
      expect(ctrl.pattern).toBe("^\\d{5}$");
      expect(ctrl.description).toBe("US ZIP code");
    });
  });

  // ── applyFormDefaults ────────────────────────────────────────────────────

  describe("applyFormDefaults", () => {
    it("fills in name from id when only id is provided", () => {
      const form = applyFormDefaults({ id: "user_registration" });
      expect(form.name).toBe("User Registration");
    });

    it("defaults version to 1", () => {
      const form = applyFormDefaults({ id: "test" });
      expect(form.version).toBe(1);
    });

    it("defaults status to active", () => {
      const form = applyFormDefaults({ id: "test" });
      expect(form.status).toBe("active");
    });

    it("applies default UX settings", () => {
      const form = applyFormDefaults({ id: "test" });
      expect(form.ux?.allowUndo).toBe(true);
      expect(form.ux?.allowSkip).toBe(true);
      expect(form.ux?.maxUndoSteps).toBe(5);
      expect(form.ux?.showExamples).toBe(true);
      expect(form.ux?.showExplanations).toBe(true);
      expect(form.ux?.allowAutofill).toBe(true);
    });

    it("applies default TTL settings", () => {
      const form = applyFormDefaults({ id: "test" });
      expect(form.ttl?.minDays).toBe(14);
      expect(form.ttl?.maxDays).toBe(90);
      expect(form.ttl?.effortMultiplier).toBe(0.5);
    });

    it("applies default nudge settings", () => {
      const form = applyFormDefaults({ id: "test" });
      expect(form.nudge?.enabled).toBe(true);
      expect(form.nudge?.afterInactiveHours).toBe(48);
      expect(form.nudge?.maxNudges).toBe(3);
    });

    it("defaults debug to false", () => {
      const form = applyFormDefaults({ id: "test" });
      expect(form.debug).toBe(false);
    });

    it("preserves original controls array due to spread order", () => {
      // NOTE: applyFormDefaults spreads `...form` last, so the original
      // controls array overwrites the defaulted one. Callers should use
      // applyControlDefaults separately or rely on FormBuilder for defaults.
      const rawControl = { key: "name" } as FormControl;
      const form = applyFormDefaults({
        id: "test",
        controls: [rawControl],
      });
      // The original control object is preserved because ...form overwrites
      expect(form.controls[0]).toBe(rawControl);
    });

    it("preserves explicitly set form values", () => {
      const form = applyFormDefaults({
        id: "test",
        name: "My Custom Form",
        version: 5,
        status: "draft",
        debug: true,
      });
      expect(form.name).toBe("My Custom Form");
      expect(form.version).toBe(5);
      expect(form.status).toBe("draft");
      expect(form.debug).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. BUILDER TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Builder Module", () => {
  // ── ControlBuilder ───────────────────────────────────────────────────────

  describe("ControlBuilder", () => {
    describe("static factories", () => {
      it("creates a text field", () => {
        const ctrl = ControlBuilder.text("name").build();
        expect(ctrl.key).toBe("name");
        expect(ctrl.type).toBe("text");
      });

      it("creates an email field", () => {
        const ctrl = ControlBuilder.email("email").build();
        expect(ctrl.type).toBe("email");
      });

      it("creates a number field", () => {
        const ctrl = ControlBuilder.number("age").build();
        expect(ctrl.type).toBe("number");
      });

      it("creates a boolean field", () => {
        const ctrl = ControlBuilder.boolean("agree").build();
        expect(ctrl.type).toBe("boolean");
      });

      it("creates a select field with options", () => {
        const opts = [{ value: "a", label: "Option A" }];
        const ctrl = ControlBuilder.select("choice", opts).build();
        expect(ctrl.type).toBe("select");
        expect(ctrl.options).toHaveLength(1);
        expect(ctrl.options![0].value).toBe("a");
      });

      it("creates a date field", () => {
        const ctrl = ControlBuilder.date("birthday").build();
        expect(ctrl.type).toBe("date");
      });

      it("creates a file field", () => {
        const ctrl = ControlBuilder.file("avatar").build();
        expect(ctrl.type).toBe("file");
      });

      it("creates a generic field via field()", () => {
        const ctrl = ControlBuilder.field("misc").build();
        expect(ctrl.key).toBe("misc");
        // Default type when not set is "text"
        expect(ctrl.type).toBe("text");
      });
    });

    describe("behavior chaining", () => {
      it("marks field as required", () => {
        const ctrl = C.text("name").required().build();
        expect(ctrl.required).toBe(true);
      });

      it("marks field as optional", () => {
        const ctrl = C.text("name").required().optional().build();
        expect(ctrl.required).toBe(false);
      });

      it("marks field as hidden", () => {
        const ctrl = C.text("ref").hidden().build();
        expect(ctrl.hidden).toBe(true);
      });

      it("marks field as sensitive", () => {
        const ctrl = C.text("password").sensitive().build();
        expect(ctrl.sensitive).toBe(true);
      });

      it("marks field as readonly", () => {
        const ctrl = C.text("id").readonly().build();
        expect(ctrl.readonly).toBe(true);
      });

      it("marks field as multiple", () => {
        const ctrl = C.text("tags").multiple().build();
        expect(ctrl.multiple).toBe(true);
      });
    });

    describe("validation chaining", () => {
      it("sets pattern", () => {
        const ctrl = C.text("zip").pattern("^\\d{5}$").build();
        expect(ctrl.pattern).toBe("^\\d{5}$");
      });

      it("sets min and max", () => {
        const ctrl = C.number("age").min(0).max(150).build();
        expect(ctrl.min).toBe(0);
        expect(ctrl.max).toBe(150);
      });

      it("sets minLength and maxLength", () => {
        const ctrl = C.text("username").minLength(3).maxLength(20).build();
        expect(ctrl.minLength).toBe(3);
        expect(ctrl.maxLength).toBe(20);
      });

      it("sets enum values", () => {
        const ctrl = C.text("size").enum(["S", "M", "L"]).build();
        expect(ctrl.enum).toEqual(["S", "M", "L"]);
      });
    });

    describe("agent hint chaining", () => {
      it("sets label", () => {
        const ctrl = C.text("name").label("Full Name").build();
        expect(ctrl.label).toBe("Full Name");
      });

      it("sets askPrompt via ask()", () => {
        const ctrl = C.text("email").ask("What is your email?").build();
        expect(ctrl.askPrompt).toBe("What is your email?");
      });

      it("sets description", () => {
        const ctrl = C.text("order").description("Order reference number").build();
        expect(ctrl.description).toBe("Order reference number");
      });

      it("sets extractHints via hint()", () => {
        const ctrl = C.text("wallet").hint("base58", "solana address").build();
        expect(ctrl.extractHints).toEqual(["base58", "solana address"]);
      });

      it("sets example", () => {
        const ctrl = C.email("email").example("user@example.com").build();
        expect(ctrl.example).toBe("user@example.com");
      });

      it("sets confirmThreshold", () => {
        const ctrl = C.number("amount").confirmThreshold(0.95).build();
        expect(ctrl.confirmThreshold).toBe(0.95);
      });
    });

    describe("file options chaining", () => {
      it("sets accept MIME types", () => {
        const ctrl = C.file("doc").accept(["image/*", "application/pdf"]).build();
        expect(ctrl.file?.accept).toEqual(["image/*", "application/pdf"]);
      });

      it("sets maxSize", () => {
        const ctrl = C.file("doc").maxSize(5 * 1024 * 1024).build();
        expect(ctrl.file?.maxSize).toBe(5 * 1024 * 1024);
      });

      it("sets maxFiles", () => {
        const ctrl = C.file("docs").maxFiles(3).build();
        expect(ctrl.file?.maxFiles).toBe(3);
      });

      it("combines multiple file options", () => {
        const ctrl = C.file("upload")
          .accept(["image/*"])
          .maxSize(1024)
          .maxFiles(5)
          .build();
        expect(ctrl.file?.accept).toEqual(["image/*"]);
        expect(ctrl.file?.maxSize).toBe(1024);
        expect(ctrl.file?.maxFiles).toBe(5);
      });
    });

    describe("access and binding chaining", () => {
      it("sets roles", () => {
        const ctrl = C.text("discount").roles("admin", "sales").build();
        expect(ctrl.roles).toEqual(["admin", "sales"]);
      });

      it("sets default value", () => {
        const ctrl = C.text("country").default("US").build();
        expect(ctrl.defaultValue).toBe("US");
      });

      it("sets dependsOn", () => {
        const ctrl = C.text("state").dependsOn("country", "equals", "US").build();
        expect(ctrl.dependsOn).toEqual({
          field: "country",
          condition: "equals",
          value: "US",
        });
      });

      it("sets dependsOn with default condition", () => {
        const ctrl = C.text("details").dependsOn("hasDetails").build();
        expect(ctrl.dependsOn?.condition).toBe("exists");
      });

      it("sets dbbind", () => {
        const ctrl = C.text("email").dbbind("email_address").build();
        expect(ctrl.dbbind).toBe("email_address");
      });
    });

    describe("UI chaining", () => {
      it("sets section", () => {
        const ctrl = C.text("name").section("Personal Info").build();
        expect(ctrl.ui?.section).toBe("Personal Info");
      });

      it("sets order", () => {
        const ctrl = C.text("name").order(1).build();
        expect(ctrl.ui?.order).toBe(1);
      });

      it("sets placeholder", () => {
        const ctrl = C.text("name").placeholder("Enter your name").build();
        expect(ctrl.ui?.placeholder).toBe("Enter your name");
      });

      it("sets helpText", () => {
        const ctrl = C.text("name").helpText("Your legal full name").build();
        expect(ctrl.ui?.helpText).toBe("Your legal full name");
      });

      it("sets widget", () => {
        const ctrl = C.text("bio").widget("textarea").build();
        expect(ctrl.ui?.widget).toBe("textarea");
      });

      it("combines multiple UI options", () => {
        const ctrl = C.text("name")
          .section("Basic")
          .order(1)
          .placeholder("Name")
          .helpText("Help")
          .widget("fancy-input")
          .build();
        expect(ctrl.ui?.section).toBe("Basic");
        expect(ctrl.ui?.order).toBe(1);
        expect(ctrl.ui?.placeholder).toBe("Name");
        expect(ctrl.ui?.helpText).toBe("Help");
        expect(ctrl.ui?.widget).toBe("fancy-input");
      });
    });

    describe("i18n and meta chaining", () => {
      it("sets i18n translations for a locale", () => {
        const ctrl = C.text("name")
          .i18n("es", { label: "Nombre", askPrompt: "¿Cómo te llamas?" })
          .build();
        expect(ctrl.i18n?.es?.label).toBe("Nombre");
        expect(ctrl.i18n?.es?.askPrompt).toBe("¿Cómo te llamas?");
      });

      it("adds meta key-value pairs", () => {
        const ctrl = C.text("name")
          .meta("priority", "high")
          .meta("category", "identity")
          .build();
        expect(ctrl.meta?.priority).toBe("high");
        expect(ctrl.meta?.category).toBe("identity");
      });
    });

    describe("build output", () => {
      it("auto-generates label from key via prettify", () => {
        const ctrl = C.text("first_name").build();
        expect(ctrl.label).toBe("First Name");
      });

      it("uses explicit label over auto-generated", () => {
        const ctrl = C.text("first_name").label("Given Name").build();
        expect(ctrl.label).toBe("Given Name");
      });

      it("defaults type to text when using field()", () => {
        const ctrl = C.field("misc").build();
        expect(ctrl.type).toBe("text");
      });
    });
  });

  // ── FormBuilder ──────────────────────────────────────────────────────────

  describe("FormBuilder", () => {
    describe("creation and metadata", () => {
      it("creates a form with create()", () => {
        const form = FormBuilder.create("contact").build();
        expect(form.id).toBe("contact");
      });

      it("creates a form using the Form alias", () => {
        const form = Form.create("test").build();
        expect(form.id).toBe("test");
      });

      it("sets name", () => {
        const form = Form.create("test").name("Test Form").build();
        expect(form.name).toBe("Test Form");
      });

      it("auto-generates name from id", () => {
        const form = Form.create("user_registration").build();
        expect(form.name).toBe("User Registration");
      });

      it("sets description", () => {
        const form = Form.create("test").description("A test form").build();
        expect(form.description).toBe("A test form");
      });

      it("sets version", () => {
        const form = Form.create("test").version(3).build();
        expect(form.version).toBe(3);
      });
    });

    describe("controls", () => {
      it("adds a single control from ControlBuilder", () => {
        const form = Form.create("test")
          .control(C.email("email").required())
          .build();
        expect(form.controls).toHaveLength(1);
        expect(form.controls[0].key).toBe("email");
        expect(form.controls[0].type).toBe("email");
        expect(form.controls[0].required).toBe(true);
      });

      it("adds a single control from plain FormControl object", () => {
        const ctrl: FormControl = { key: "name", label: "Name", type: "text" };
        const form = Form.create("test").control(ctrl).build();
        expect(form.controls).toHaveLength(1);
        expect(form.controls[0]).toEqual(ctrl);
      });

      it("adds multiple controls via controls()", () => {
        const form = Form.create("test")
          .controls(
            C.text("name"),
            C.email("email"),
            C.number("age"),
          )
          .build();
        expect(form.controls).toHaveLength(3);
      });

      it("adds required shorthand fields", () => {
        const form = Form.create("test").required("name", "email").build();
        expect(form.controls).toHaveLength(2);
        expect(form.controls[0].key).toBe("name");
        expect(form.controls[0].required).toBe(true);
        expect(form.controls[1].key).toBe("email");
        expect(form.controls[1].required).toBe(true);
      });

      it("adds optional shorthand fields", () => {
        const form = Form.create("test").optional("phone", "notes").build();
        expect(form.controls).toHaveLength(2);
        expect(form.controls[0].required).toBeFalsy();
        expect(form.controls[1].required).toBeFalsy();
      });
    });

    describe("permissions", () => {
      it("sets roles", () => {
        const form = Form.create("admin_form").roles("admin", "moderator").build();
        expect(form.roles).toEqual(["admin", "moderator"]);
      });

      it("sets allowMultiple", () => {
        const form = Form.create("order").allowMultiple().build();
        expect(form.allowMultiple).toBe(true);
      });
    });

    describe("UX options", () => {
      it("disables undo", () => {
        const form = Form.create("legal").noUndo().build();
        expect(form.ux?.allowUndo).toBe(false);
      });

      it("disables skip", () => {
        const form = Form.create("strict").noSkip().build();
        expect(form.ux?.allowSkip).toBe(false);
      });

      it("disables autofill", () => {
        const form = Form.create("secure").noAutofill().build();
        expect(form.ux?.allowAutofill).toBe(false);
      });

      it("sets maxUndoSteps", () => {
        const form = Form.create("test").maxUndoSteps(10).build();
        expect(form.ux?.maxUndoSteps).toBe(10);
      });
    });

    describe("TTL and nudge", () => {
      it("configures TTL", () => {
        const form = Form.create("test")
          .ttl({ minDays: 7, maxDays: 30, effortMultiplier: 1.0 })
          .build();
        expect(form.ttl?.minDays).toBe(7);
        expect(form.ttl?.maxDays).toBe(30);
        expect(form.ttl?.effortMultiplier).toBe(1.0);
      });

      it("disables nudge", () => {
        const form = Form.create("test").noNudge().build();
        expect(form.nudge?.enabled).toBe(false);
      });

      it("sets nudge inactivity hours", () => {
        const form = Form.create("test").nudgeAfter(24).build();
        expect(form.nudge?.afterInactiveHours).toBe(24);
      });

      it("sets custom nudge message", () => {
        const form = Form.create("test").nudgeMessage("Hey, come back!").build();
        expect(form.nudge?.message).toBe("Hey, come back!");
      });
    });

    describe("hooks", () => {
      it("sets onStart hook", () => {
        const form = Form.create("test").onStart("handle_start").build();
        expect(form.hooks?.onStart).toBe("handle_start");
      });

      it("sets onFieldChange hook", () => {
        const form = Form.create("test").onFieldChange("handle_change").build();
        expect(form.hooks?.onFieldChange).toBe("handle_change");
      });

      it("sets onReady hook", () => {
        const form = Form.create("test").onReady("handle_ready").build();
        expect(form.hooks?.onReady).toBe("handle_ready");
      });

      it("sets onSubmit hook", () => {
        const form = Form.create("test").onSubmit("handle_submit").build();
        expect(form.hooks?.onSubmit).toBe("handle_submit");
      });

      it("sets onCancel hook", () => {
        const form = Form.create("test").onCancel("handle_cancel").build();
        expect(form.hooks?.onCancel).toBe("handle_cancel");
      });

      it("sets onExpire hook", () => {
        const form = Form.create("test").onExpire("handle_expire").build();
        expect(form.hooks?.onExpire).toBe("handle_expire");
      });

      it("sets multiple hooks at once", () => {
        const form = Form.create("test")
          .hooks({
            onStart: "start_worker",
            onSubmit: "submit_worker",
          })
          .build();
        expect(form.hooks?.onStart).toBe("start_worker");
        expect(form.hooks?.onSubmit).toBe("submit_worker");
      });
    });

    describe("debug, i18n, meta", () => {
      it("enables debug mode", () => {
        const form = Form.create("test").debug().build();
        expect(form.debug).toBe(true);
      });

      it("adds i18n translations", () => {
        const form = Form.create("test")
          .i18n("es", { name: "Formulario de prueba" })
          .build();
        expect(form.i18n?.es?.name).toBe("Formulario de prueba");
      });

      it("adds meta key-value pairs", () => {
        const form = Form.create("test")
          .meta("category", "onboarding")
          .meta("priority", 1)
          .build();
        expect(form.meta?.category).toBe("onboarding");
        expect(form.meta?.priority).toBe(1);
      });
    });

    describe("build output structure", () => {
      it("produces a complete FormDefinition with all configured options", () => {
        const form = Form.create("registration")
          .name("Registration Form")
          .description("Register a new account")
          .version(2)
          .control(C.email("email").required())
          .control(C.text("name").required())
          .roles("user")
          .onSubmit("handle_registration")
          .ttl({ minDays: 7 })
          .debug()
          .build();

        expect(form.id).toBe("registration");
        expect(form.name).toBe("Registration Form");
        expect(form.description).toBe("Register a new account");
        expect(form.version).toBe(2);
        expect(form.controls).toHaveLength(2);
        expect(form.roles).toEqual(["user"]);
        expect(form.hooks?.onSubmit).toBe("handle_registration");
        expect(form.ttl?.minDays).toBe(7);
        expect(form.debug).toBe(true);
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. TEMPLATE TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Template Module", () => {
  // ── buildTemplateValues ──────────────────────────────────────────────────

  describe("buildTemplateValues", () => {
    it("extracts string values from session fields", () => {
      const session = makeSession({
        fields: {
          name: { status: "filled", value: "John" } as FieldState,
        },
      });
      const values = buildTemplateValues(session);
      expect(values.name).toBe("John");
    });

    it("converts number values to strings", () => {
      const session = makeSession({
        fields: {
          age: { status: "filled", value: 30 } as FieldState,
        },
      });
      const values = buildTemplateValues(session);
      expect(values.age).toBe("30");
    });

    it("converts boolean values to strings", () => {
      const session = makeSession({
        fields: {
          active: { status: "filled", value: true } as FieldState,
        },
      });
      const values = buildTemplateValues(session);
      expect(values.active).toBe("true");
    });

    it("includes context values", () => {
      const session = makeSession({
        fields: {},
        context: { org: "Acme", count: 5 },
      });
      const values = buildTemplateValues(session);
      expect(values.org).toBe("Acme");
      expect(values.count).toBe("5");
    });

    it("ignores non-scalar values (objects, arrays)", () => {
      const session = makeSession({
        fields: {
          data: { status: "filled", value: { nested: "obj" } } as FieldState,
        },
      });
      const values = buildTemplateValues(session);
      expect(values.data).toBeUndefined();
    });

    it("combines fields and context into one map", () => {
      const session = makeSession({
        fields: {
          name: { status: "filled", value: "Alice" } as FieldState,
        },
        context: { role: "admin" },
      });
      const values = buildTemplateValues(session);
      expect(values.name).toBe("Alice");
      expect(values.role).toBe("admin");
    });
  });

  // ── renderTemplate ───────────────────────────────────────────────────────

  describe("renderTemplate", () => {
    it("substitutes {{field}} placeholders", () => {
      const result = renderTemplate("Hello {{name}}, age {{age}}", {
        name: "John",
        age: "30",
      });
      expect(result).toBe("Hello John, age 30");
    });

    it("preserves placeholders when value is missing", () => {
      const result = renderTemplate("Hello {{unknown}}", { name: "John" });
      expect(result).toBe("Hello {{unknown}}");
    });

    it("handles templates with no placeholders", () => {
      const result = renderTemplate("No placeholders here", { name: "John" });
      expect(result).toBe("No placeholders here");
    });

    it("returns undefined for undefined input", () => {
      expect(renderTemplate(undefined, { name: "John" })).toBeUndefined();
    });

    it("handles spaces inside braces", () => {
      const result = renderTemplate("Hello {{ name }}", { name: "John" });
      expect(result).toBe("Hello John");
    });

    it("handles multiple occurrences of the same placeholder", () => {
      const result = renderTemplate("{{x}} and {{x}}", { x: "hello" });
      expect(result).toBe("hello and hello");
    });
  });

  // ── resolveControlTemplates ──────────────────────────────────────────────

  describe("resolveControlTemplates", () => {
    const values = { name: "Alice", product: "Widget" };

    it("resolves templates in label", () => {
      const ctrl = makeControl({ label: "Greeting for {{name}}" });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.label).toBe("Greeting for Alice");
    });

    it("resolves templates in description", () => {
      const ctrl = makeControl({ description: "Details about {{product}}" });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.description).toBe("Details about Widget");
    });

    it("resolves templates in askPrompt", () => {
      const ctrl = makeControl({ askPrompt: "Hi {{name}}, what is your email?" });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.askPrompt).toBe("Hi Alice, what is your email?");
    });

    it("resolves templates in example", () => {
      const ctrl = makeControl({ example: "{{name}}@company.com" });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.example).toBe("Alice@company.com");
    });

    it("resolves templates in extractHints", () => {
      const ctrl = makeControl({ extractHints: ["{{name}}'s email", "email for {{product}}"] });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.extractHints).toEqual(["Alice's email", "email for Widget"]);
    });

    it("resolves templates in option labels and descriptions", () => {
      const ctrl = makeControl({
        type: "select",
        options: [
          { value: "a", label: "Option for {{name}}", description: "{{product}} tier" },
        ],
      });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.options![0].label).toBe("Option for Alice");
      expect(resolved.options![0].description).toBe("Widget tier");
    });

    it("recursively resolves nested fields", () => {
      const ctrl = makeControl({
        fields: [
          makeControl({ key: "sub", label: "Sub for {{name}}" }),
        ],
      });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.fields![0].label).toBe("Sub for Alice");
    });

    it("preserves non-template fields unchanged", () => {
      const ctrl = makeControl({ key: "email", type: "email", required: true });
      const resolved = resolveControlTemplates(ctrl, values);
      expect(resolved.key).toBe("email");
      expect(resolved.type).toBe("email");
      expect(resolved.required).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. BUILTINS TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Builtins Module", () => {
  // ── Registry constants ───────────────────────────────────────────────────

  describe("BUILTIN_TYPES and BUILTIN_TYPE_MAP", () => {
    it("contains exactly 7 built-in types", () => {
      expect(BUILTIN_TYPES).toHaveLength(7);
    });

    it("includes all expected type ids", () => {
      const ids = BUILTIN_TYPES.map((t) => t.id);
      expect(ids).toContain("text");
      expect(ids).toContain("number");
      expect(ids).toContain("email");
      expect(ids).toContain("boolean");
      expect(ids).toContain("select");
      expect(ids).toContain("date");
      expect(ids).toContain("file");
    });

    it("marks all types as builtin", () => {
      for (const type of BUILTIN_TYPES) {
        expect(type.builtin).toBe(true);
      }
    });

    it("provides O(1) lookup via BUILTIN_TYPE_MAP", () => {
      expect(BUILTIN_TYPE_MAP.get("text")?.id).toBe("text");
      expect(BUILTIN_TYPE_MAP.get("number")?.id).toBe("number");
      expect(BUILTIN_TYPE_MAP.get("nonexistent")).toBeUndefined();
    });
  });

  // ── isBuiltinType ────────────────────────────────────────────────────────

  describe("isBuiltinType", () => {
    it.each(["text", "number", "email", "boolean", "select", "date", "file"])(
      'returns true for built-in type "%s"',
      (typeId) => {
        expect(isBuiltinType(typeId)).toBe(true);
      },
    );

    it("returns false for a non-built-in type", () => {
      expect(isBuiltinType("custom_phone")).toBe(false);
      expect(isBuiltinType("solana_address")).toBe(false);
    });
  });

  // ── getBuiltinType ───────────────────────────────────────────────────────

  describe("getBuiltinType", () => {
    it("returns the ControlType for a known type", () => {
      const emailType = getBuiltinType("email");
      expect(emailType).toBeDefined();
      expect(emailType!.id).toBe("email");
      expect(emailType!.validate).toBeDefined();
      expect(emailType!.parse).toBeDefined();
      expect(emailType!.format).toBeDefined();
      expect(emailType!.extractionPrompt).toBeDefined();
    });

    it("returns undefined for an unknown type", () => {
      expect(getBuiltinType("not_a_type")).toBeUndefined();
    });
  });

  // ── registerBuiltinTypes ─────────────────────────────────────────────────

  describe("registerBuiltinTypes", () => {
    it("registers all 7 types via the provided function", () => {
      const registered: ControlType[] = [];
      const registerFn = (type: ControlType) => {
        registered.push(type);
      };
      registerBuiltinTypes(registerFn);
      expect(registered).toHaveLength(7);
      const ids = registered.map((t) => t.id);
      expect(ids).toContain("text");
      expect(ids).toContain("file");
    });
  });

  // ── Individual type validation / parse / format ──────────────────────────

  describe("text type", () => {
    const textType = getBuiltinType("text")!;

    it("validates null/undefined as valid (empty check is separate)", () => {
      expect(textType.validate!(null, makeControl()).valid).toBe(true);
      expect(textType.validate!(undefined as never, makeControl()).valid).toBe(true);
    });

    it("validates a plain string as valid", () => {
      expect(textType.validate!("hello", makeControl()).valid).toBe(true);
    });

    it("validates minLength constraint", () => {
      const ctrl = makeControl({ minLength: 5 });
      expect(textType.validate!("ab", ctrl).valid).toBe(false);
      expect(textType.validate!("abcde", ctrl).valid).toBe(true);
    });

    it("validates maxLength constraint", () => {
      const ctrl = makeControl({ maxLength: 3 });
      expect(textType.validate!("abcd", ctrl).valid).toBe(false);
      expect(textType.validate!("abc", ctrl).valid).toBe(true);
    });

    it("validates pattern constraint", () => {
      const ctrl = makeControl({ pattern: "^[0-9]+$" });
      expect(textType.validate!("123", ctrl).valid).toBe(true);
      expect(textType.validate!("abc", ctrl).valid).toBe(false);
    });

    it("validates enum constraint", () => {
      const ctrl = makeControl({ enum: ["red", "green", "blue"] });
      expect(textType.validate!("red", ctrl).valid).toBe(true);
      expect(textType.validate!("yellow", ctrl).valid).toBe(false);
    });

    it("parses by trimming whitespace", () => {
      expect(textType.parse!("  hello  ")).toBe("hello");
    });

    it("formats value to string", () => {
      expect(textType.format!(42)).toBe("42");
      expect(textType.format!(null)).toBe("");
    });
  });

  describe("number type", () => {
    const numberType = getBuiltinType("number")!;

    it("validates null/undefined/empty as valid", () => {
      expect(numberType.validate!(null, makeControl()).valid).toBe(true);
      expect(numberType.validate!("", makeControl()).valid).toBe(true);
    });

    it("validates a valid number", () => {
      expect(numberType.validate!(42, makeControl()).valid).toBe(true);
      expect(numberType.validate!(3.14, makeControl()).valid).toBe(true);
    });

    it("rejects non-numeric strings", () => {
      const result = numberType.validate!("abc", makeControl());
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid number");
    });

    it("validates min constraint", () => {
      const ctrl = makeControl({ min: 10 });
      expect(numberType.validate!(5, ctrl).valid).toBe(false);
      expect(numberType.validate!(10, ctrl).valid).toBe(true);
      expect(numberType.validate!(15, ctrl).valid).toBe(true);
    });

    it("validates max constraint", () => {
      const ctrl = makeControl({ max: 100 });
      expect(numberType.validate!(150, ctrl).valid).toBe(false);
      expect(numberType.validate!(100, ctrl).valid).toBe(true);
    });

    it("parses numeric strings, removing formatting characters", () => {
      expect(numberType.parse!("1,234.56")).toBe(1234.56);
      expect(numberType.parse!("$50")).toBe(50);
      expect(numberType.parse!(" 42 ")).toBe(42);
    });

    it("formats numbers with locale string", () => {
      const result = numberType.format!(1234);
      expect(result).toContain("1");
      expect(result).toContain("234");
    });

    it("formats null as empty string", () => {
      expect(numberType.format!(null)).toBe("");
    });
  });

  describe("email type", () => {
    const emailType = getBuiltinType("email")!;

    it("validates null/undefined/empty as valid", () => {
      expect(emailType.validate!(null, makeControl()).valid).toBe(true);
      expect(emailType.validate!("", makeControl()).valid).toBe(true);
    });

    it("validates a proper email", () => {
      expect(emailType.validate!("user@example.com", makeControl()).valid).toBe(true);
    });

    it("rejects an email without @", () => {
      expect(emailType.validate!("userexample.com", makeControl()).valid).toBe(false);
    });

    it("rejects an email without domain", () => {
      expect(emailType.validate!("user@", makeControl()).valid).toBe(false);
    });

    it("parses by trimming and lowercasing", () => {
      expect(emailType.parse!("  User@Example.COM  ")).toBe("user@example.com");
    });

    it("formats by lowercasing", () => {
      expect(emailType.format!("USER@EXAMPLE.COM")).toBe("user@example.com");
    });
  });

  describe("boolean type", () => {
    const booleanType = getBuiltinType("boolean")!;

    it("validates null/undefined as valid", () => {
      expect(booleanType.validate!(null, makeControl()).valid).toBe(true);
    });

    it("validates native booleans", () => {
      expect(booleanType.validate!(true, makeControl()).valid).toBe(true);
      expect(booleanType.validate!(false, makeControl()).valid).toBe(true);
    });

    it.each(["true", "false", "yes", "no", "1", "0", "on", "off"])(
      'validates string "%s" as valid boolean',
      (val) => {
        expect(booleanType.validate!(val, makeControl()).valid).toBe(true);
      },
    );

    it("rejects invalid boolean strings", () => {
      expect(booleanType.validate!("maybe", makeControl()).valid).toBe(false);
    });

    it("parses truthy strings to true", () => {
      expect(booleanType.parse!("yes")).toBe(true);
      expect(booleanType.parse!("1")).toBe(true);
      expect(booleanType.parse!("on")).toBe(true);
      expect(booleanType.parse!("true")).toBe(true);
    });

    it("parses falsy strings to false", () => {
      expect(booleanType.parse!("no")).toBe(false);
      expect(booleanType.parse!("0")).toBe(false);
      expect(booleanType.parse!("off")).toBe(false);
      expect(booleanType.parse!("false")).toBe(false);
    });

    it('formats true as "Yes"', () => {
      expect(booleanType.format!(true)).toBe("Yes");
    });

    it('formats false as "No"', () => {
      expect(booleanType.format!(false)).toBe("No");
    });
  });

  describe("select type", () => {
    const selectType = getBuiltinType("select")!;

    it("validates null/undefined/empty as valid", () => {
      expect(selectType.validate!(null, makeControl()).valid).toBe(true);
      expect(selectType.validate!("", makeControl()).valid).toBe(true);
    });

    it("validates a value matching defined options", () => {
      const ctrl = makeControl({
        options: [
          { value: "US", label: "United States" },
          { value: "CA", label: "Canada" },
        ],
      });
      expect(selectType.validate!("US", ctrl).valid).toBe(true);
    });

    it("rejects a value not in defined options", () => {
      const ctrl = makeControl({
        options: [{ value: "US", label: "United States" }],
      });
      const result = selectType.validate!("XX", ctrl);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Must be one of");
    });

    it("validates against enum when no options defined", () => {
      const ctrl = makeControl({ enum: ["small", "medium", "large"] });
      expect(selectType.validate!("small", ctrl).valid).toBe(true);
      expect(selectType.validate!("huge", ctrl).valid).toBe(false);
    });

    it("accepts any value when no options or enum defined", () => {
      expect(selectType.validate!("anything", makeControl()).valid).toBe(true);
    });

    it("parses by trimming whitespace", () => {
      expect(selectType.parse!("  US  ")).toBe("US");
    });

    it("formats value as string", () => {
      expect(selectType.format!("US")).toBe("US");
    });
  });

  describe("date type", () => {
    const dateType = getBuiltinType("date")!;

    it("validates null/undefined/empty as valid", () => {
      expect(dateType.validate!(null, makeControl()).valid).toBe(true);
      expect(dateType.validate!("", makeControl()).valid).toBe(true);
    });

    it("validates an ISO date string", () => {
      expect(dateType.validate!("2024-06-15", makeControl()).valid).toBe(true);
    });

    it("rejects a non-ISO date format", () => {
      const result = dateType.validate!("June 15, 2024", makeControl());
      expect(result.valid).toBe(false);
      expect(result.error).toContain("YYYY-MM-DD");
    });

    it("rejects an impossible date (passes regex but invalid Date)", () => {
      // "2024-13-45" matches \d{4}-\d{2}-\d{2} but is not a valid date
      const result = dateType.validate!("2024-13-45", makeControl());
      expect(result.valid).toBe(false);
    });

    it("parses a date string to ISO format", () => {
      const result = dateType.parse!("2024-06-15");
      expect(result).toBe("2024-06-15");
    });

    it("normalizes non-ISO input to ISO", () => {
      const result = dateType.parse!("June 15, 2024");
      // Should parse to ISO YYYY-MM-DD
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("formats a date for locale display", () => {
      const result = dateType.format!("2024-06-15");
      // Locale-dependent, but should be a non-empty string
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toBe("Invalid Date");
    });

    it("formats null as empty string", () => {
      expect(dateType.format!(null)).toBe("");
    });
  });

  describe("file type", () => {
    const fileType = getBuiltinType("file")!;

    it("validates null/undefined as valid", () => {
      expect(fileType.validate!(null, makeControl()).valid).toBe(true);
    });

    it("validates an object as valid file metadata", () => {
      expect(fileType.validate!({ name: "doc.pdf" }, makeControl()).valid).toBe(true);
    });

    it("validates an array (multiple files) as valid", () => {
      expect(
        fileType.validate!([{ name: "a.pdf" }, { name: "b.pdf" }], makeControl()).valid,
      ).toBe(true);
    });

    it("rejects a non-object value (string)", () => {
      const result = fileType.validate!("not a file", makeControl());
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid file data");
    });

    it("formats an array as file count", () => {
      expect(fileType.format!([{ name: "a" }, { name: "b" }])).toBe("2 file(s)");
    });

    it("formats a single object with name", () => {
      expect(fileType.format!({ name: "report.pdf" })).toBe("report.pdf");
    });

    it('formats null as empty string', () => {
      expect(fileType.format!(null)).toBe("");
    });

    it('formats unknown object as "File attached"', () => {
      expect(fileType.format!({ size: 1024 })).toBe("File attached");
    });
  });

  // ── Extraction prompts ─────────────────────────────────────────────────

  describe("extraction prompts", () => {
    it("each built-in type has an extractionPrompt", () => {
      for (const type of BUILTIN_TYPES) {
        expect(type.extractionPrompt).toBeDefined();
        expect(typeof type.extractionPrompt).toBe("string");
        expect(type.extractionPrompt!.length).toBeGreaterThan(0);
      }
    });
  });
});

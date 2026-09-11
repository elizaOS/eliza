/**
 * Regression coverage for the control-type registry bridge (#31049): a type
 * registered through FormService.registerControlType must reach extraction,
 * parsing, validation, and display for top-level fields, and the builtin
 * `date` type must name the same calendar day on every host timezone. Runs
 * the real FormService, extractor prompt builder, and validation module with a
 * deterministic in-memory runtime; the host timezone is switched per case.
 */
import type { Component, IAgentRuntime, JsonValue, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFormExtractorPromptSection } from "./extraction";
import { FormService } from "./service";
import type { FormControl, FormDefinition } from "./types";
import {
  clearTypeHandlers,
  formatValue,
  getTypeHandler,
  parseValue,
  validateField,
} from "./validation";

const agentId = "00000000-0000-4000-8000-000000000203" as UUID;

function makeRuntime(): IAgentRuntime {
  const components = new Map<string, Component>();
  return {
    agentId,
    getRoom: vi.fn(async () => ({ id: agentId, worldId: agentId })),
    getComponent: vi.fn(async (entity: UUID, type: string) =>
      components.get(`${entity}:${type}`),
    ),
    getComponents: vi.fn(async (entity: UUID) =>
      Array.from(components.values()).filter((c) => c.entityId === entity),
    ),
    createComponent: vi.fn(async (component: Component) => {
      components.set(`${component.entityId}:${component.type}`, component);
    }),
    updateComponent: vi.fn(async (component: Component) => {
      components.set(`${component.entityId}:${component.type}`, component);
    }),
    deleteComponent: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    registerTaskWorker: vi.fn(),
    logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as unknown as IAgentRuntime;
}

const dateControl: FormControl = {
  key: "dueDate",
  label: "Due date",
  type: "date",
};
const numberControl: FormControl = { key: "age", label: "Age", type: "number" };
const phoneControl: FormControl = {
  key: "phone",
  label: "Phone",
  type: "phone",
};

function promptFor(controls: FormControl[]): string {
  const form: FormDefinition = { id: "f", name: "F", controls };
  return buildFormExtractorPromptSection({
    text: "hello",
    form,
    controls,
  });
}

describe("control type registry bridge (#31049)", () => {
  let service: FormService;

  beforeEach(async () => {
    clearTypeHandlers();
    service = (await FormService.start(makeRuntime())) as FormService;
  });

  afterEach(() => {
    clearTypeHandlers();
  });

  it("publishes builtin extraction prompts to the extractor", () => {
    expect(getTypeHandler("date")?.extractionPrompt).toBe(
      "a date (preferably in YYYY-MM-DD format)",
    );
    const prompt = promptFor([dateControl]);
    expect(prompt).toContain("a date (preferably in YYYY-MM-DD format)");
    expect(prompt).not.toContain('"type": "date"');
  });

  it("keeps builtin parsing and validation on the hardened switch paths", () => {
    // The builtin number ControlType parses with a lenient parseFloat; the
    // switch in parseValue preserves a rejected answer verbatim so it stays
    // invalid through persistence. Publishing the builtin's parse would
    // silently reintroduce coercion of garbage-suffixed input.
    expect(getTypeHandler("number")?.parse).toBeUndefined();
    expect(getTypeHandler("number")?.validate).toBeUndefined();
    expect(parseValue("12abc", numberControl)).toBe("12abc");
    expect(validateField("12abc", numberControl).valid).toBe(false);
  });

  it("runs a custom simple type's validate, parse, format, and prompt for a top-level field", () => {
    service.registerControlType({
      id: "phone",
      validate: (value: JsonValue) =>
        /^\+?[\d\s-]{10,}$/.test(String(value))
          ? { valid: true }
          : { valid: false, error: "Invalid phone" },
      parse: (value: string) => value.replace(/[^\d+]/g, ""),
      format: (value: JsonValue) => `tel:${String(value)}`,
      extractionPrompt: "a phone number with country code",
    });

    expect(promptFor([phoneControl])).toContain(
      "a phone number with country code",
    );
    expect(validateField("hello there", phoneControl)).toEqual({
      valid: false,
      error: "Invalid phone",
    });
    expect(validateField("+1 555 123 4567", phoneControl).valid).toBe(true);
    expect(parseValue("+1 (555) 123-4567", phoneControl)).toBe("+15551234567");
    expect(formatValue("+15551234567", phoneControl)).toBe("tel:+15551234567");
  });
});

describe("date control names the same calendar day on every host (#31049)", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    clearTypeHandlers();
  });

  it.each([
    "Asia/Tokyo",
    "Europe/Berlin",
    "America/Los_Angeles",
    "Pacific/Auckland",
    "UTC",
  ])("resolves natural-language answers to the named day under TZ=%s", (tz) => {
    process.env.TZ = tz;
    for (const input of [
      "2026-09-15",
      "September 15, 2026",
      "9/15/2026",
      "15 Sep 2026",
      "  2026-09-15  ",
    ]) {
      const parsed = parseValue(input, dateControl);
      expect(parsed, `${tz}: ${input}`).toBe("2026-09-15");
      expect(validateField(parsed, dateControl).valid, `${tz}: ${input}`).toBe(
        true,
      );
    }
  });

  it.each(["Asia/Tokyo", "America/Los_Angeles", "UTC"])(
    "displays a stored calendar day as that day under TZ=%s",
    (tz) => {
      process.env.TZ = tz;
      const shown = formatValue("2026-09-15", dateControl);
      expect(shown).toMatch(/15/);
      expect(shown).toMatch(/2026/);
      expect(shown).not.toMatch(/14|16/);
    },
  );

  it("rejects a year-less answer instead of storing a fabricated year", () => {
    process.env.TZ = "Asia/Tokyo";
    const parsed = parseValue("Sept 15", dateControl);
    expect(parsed).toBe("Sept 15");
    const result = validateField(parsed, dateControl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("YYYY-MM-DD");
  });

  it("rejects a rolled-over day and an instant that is not a calendar date", () => {
    expect(validateField("2026-02-30", dateControl).valid).toBe(false);
    expect(validateField("2026-09-14T15:00:00.000Z", dateControl).valid).toBe(
      false,
    );
    expect(validateField("2028-02-29", dateControl).valid).toBe(true);
  });

  it("honours min/max bounds against the named day", () => {
    const bounded: FormControl = {
      ...dateControl,
      min: Date.UTC(2026, 8, 10),
      max: Date.UTC(2026, 8, 20),
    };
    expect(validateField("2026-09-15", bounded).valid).toBe(true);
    expect(validateField("2026-09-05", bounded).valid).toBe(false);
    expect(validateField("2026-09-25", bounded).valid).toBe(false);
  });
});

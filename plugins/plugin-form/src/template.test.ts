/**
 * Unit tests for form template resolution, asserting that filled session fields
 * take precedence over initial session context, and template strings interpolate
 * placeholders across controls and subfields.
 */
import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildTemplateValues,
  renderTemplate,
  resolveControlTemplates,
} from "./template";
import type { FormControl, FormSession } from "./types";

function makeSession(overrides: Partial<FormSession> = {}): FormSession {
  const now = Date.now();
  return {
    id: "session-1",
    formId: "test_form",
    formVersion: 1,
    entityId: "00000000-0000-4000-8000-000000000001" as UUID,
    roomId: "00000000-0000-4000-8000-000000000002" as UUID,
    status: "active",
    fields: {
      name: {
        status: "filled",
        value: "Alice",
        source: "manual",
        updatedAt: now,
      },
      count: { status: "filled", value: 3, source: "manual", updatedAt: now },
      active: {
        status: "filled",
        value: true,
        source: "manual",
        updatedAt: now,
      },
      missing: { status: "empty" },
    },
    context: {
      tier: "pro",
      name: "DefaultUser",
    },
    history: [],
    effort: {
      interactionCount: 1,
      timeSpentMs: 1000,
      firstInteractionAt: now,
      lastInteractionAt: now,
    },
    expiresAt: now + 86_400_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("buildTemplateValues", () => {
  it("gives filled session fields precedence over initial session context on key collision", () => {
    const session = makeSession();
    const values = buildTemplateValues(session);

    expect(values.tier).toBe("pro");
    expect(values.name).toBe("Alice");
    expect(values.count).toBe("3");
    expect(values.active).toBe("true");
    expect(values.missing).toBeUndefined();
  });
});

describe("renderTemplate and resolveControlTemplates", () => {
  it("interpolates template placeholders and preserves unmatched keys", () => {
    const values = { name: "Alice", count: "3" };
    expect(
      renderTemplate(
        "Hello {{name}}, you have {{count}} items ({{other}})",
        values,
      ),
    ).toBe("Hello Alice, you have 3 items ({{other}})");
    expect(renderTemplate(undefined, values)).toBeUndefined();
  });

  it("resolves placeholders across control labels, askPrompts, and subfields", () => {
    const control: FormControl = {
      key: "delivery",
      label: "Delivery for {{name}}",
      type: "text",
      askPrompt: "Where should we send your {{count}} items, {{name}}?",
      options: [{ value: "standard", label: "Standard for {{name}}" }],
      fields: [
        {
          key: "sub",
          label: "Sub field for {{name}}",
          type: "text",
        },
      ],
    };

    const resolved = resolveControlTemplates(control, {
      name: "Alice",
      count: "3",
    });
    expect(resolved.label).toBe("Delivery for Alice");
    expect(resolved.askPrompt).toBe(
      "Where should we send your 3 items, Alice?",
    );
    expect(resolved.options?.[0].label).toBe("Standard for Alice");
    expect(resolved.fields?.[0].label).toBe("Sub field for Alice");
  });
});

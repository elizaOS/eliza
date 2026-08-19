/**
 * Edge-case hardening for FormService: malformed schemas, extraction against
 * adversarial input, and field-validation boundaries. Deterministic, no live
 * model.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  coerceExtractionsAgainstControls,
  parseFormExtractorOutput,
} from "./extraction";
import { MAX_FORM_CONTROL_NODES } from "./form-control-graph";
import { FormService } from "./service";
import type { FormDefinition } from "./types";
import { parseValue, validateField } from "./validation";

const entityId = "00000000-0000-4000-8000-000000000101" as UUID;
const roomId = "00000000-0000-4000-8000-000000000102" as UUID;
const agentId = "00000000-0000-4000-8000-000000000103" as UUID;

function makeRuntime() {
  const components = new Map<string, Component>();
  const keyFor = (entity: UUID, type: string) => `${entity}:${type}`;

  return {
    agentId,
    getRoom: vi.fn(async () => ({ id: roomId, worldId: agentId })),
    getComponent: vi.fn(async (entity: UUID, type: string) =>
      components.get(keyFor(entity, type)),
    ),
    getComponents: vi.fn(async (entity: UUID) =>
      Array.from(components.values()).filter((c) => c.entityId === entity),
    ),
    createComponent: vi.fn(async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
    }),
    updateComponent: vi.fn(async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
    }),
    deleteComponent: vi.fn(async (id: UUID) => {
      for (const [key, component] of components) {
        if (component.id === id) components.delete(key);
      }
    }),
    emitEvent: vi.fn(async () => undefined),
    registerTaskWorker: vi.fn(),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function validForm(overrides: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: "signup",
    name: "Signup",
    controls: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "age", label: "Age", type: "number", required: false },
    ],
    ...overrides,
  };
}

describe("FormService form schema hardening", () => {
  let service: FormService;

  beforeEach(async () => {
    service = (await FormService.start(makeRuntime())) as FormService;
  });

  it("rejects malformed form definitions before registration", () => {
    expect(() =>
      service.registerForm({ id: "bad", name: "Bad" } as FormDefinition),
    ).toThrow("Form controls must be an array");

    expect(() =>
      service.registerForm(
        validForm({
          controls: [
            { key: "name", label: "Name", type: "text" },
            { key: "name", label: "Duplicate", type: "text" },
          ],
        }),
      ),
    ).toThrow("Duplicate control key: name");
  });

  it("rejects an oversized sparse control list at registration", () => {
    expect(() =>
      service.registerForm(
        validForm({ controls: new Array(MAX_FORM_CONTROL_NODES + 1) }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "FORM_CONTROL_UNBOUNDED",
        context: expect.objectContaining({
          visits: MAX_FORM_CONTROL_NODES + 1,
        }),
      }),
    );
    expect(service.getForm("signup")).toBeUndefined();
  });

  it("rejects prototype-polluting control keys and mapped submission keys", () => {
    expect(() =>
      service.registerForm(
        validForm({
          controls: [{ key: "__proto__", label: "Pollute", type: "text" }],
        }),
      ),
    ).toThrow("Control key uses unsafe object key: __proto__");

    expect(() =>
      service.registerForm(
        validForm({
          controls: [
            {
              key: "safe",
              label: "Safe",
              type: "text",
              dbbind: "constructor",
            },
          ],
        }),
      ),
    ).toThrow("Control dbbind uses unsafe object key: constructor");
  });

  it("marks invalid initial values invalid and blocks final submission", async () => {
    service.registerForm(validForm());

    const session = await service.startSession("signup", entityId, roomId, {
      initialValues: { name: "Jane", age: "not a number" },
    });

    expect(session.fields.name.status).toBe("filled");
    expect(session.fields.age.status).toBe("invalid");
    expect(session.fields.age.error).toContain("must be a number");

    await expect(service.submit(session.id, entityId)).rejects.toThrow(
      "Field age is invalid",
    );
  });

  it("uses null-prototype value maps for retrieved session values", () => {
    service.registerForm(validForm());

    const values = service.getValues({
      id: "session",
      formId: "signup",
      formVersion: 1,
      entityId,
      roomId,
      status: "active",
      fields: {
        name: { status: "filled", value: "Jane" },
      },
      history: [],
      effort: {
        interactionCount: 0,
        timeSpentMs: 0,
        firstInteractionAt: 1,
        lastInteractionAt: 1,
      },
      expiresAt: 2,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(Object.getPrototypeOf(values)).toBe(null);
    expect(values.name).toBe("Jane");
  });

  it("ignores expired active sessions when starting or listing sessions", async () => {
    service.registerForm(validForm());
    const expired = await service.startSession("signup", entityId, roomId);
    expired.expiresAt = Date.now() - 1;
    await service.saveSession(expired);

    await expect(
      service.getActiveSession(entityId, roomId),
    ).resolves.toBeNull();
    await expect(service.getAllActiveSessions(entityId)).resolves.toEqual([]);

    const fresh = await service.startSession("signup", entityId, roomId);

    expect(fresh.id).not.toBe(expired.id);
    await expect(
      service.getActiveSession(entityId, roomId),
    ).resolves.toMatchObject({
      id: fresh.id,
      status: "active",
    });
  });

  it("does not restore or mutate expired stashed sessions", async () => {
    service.registerForm(validForm());
    const session = await service.startSession("signup", entityId, roomId);
    await service.stash(session.id, entityId);
    const stashed = await service.getStashedSessions(entityId);
    expect(stashed).toHaveLength(1);
    const stashedSession = stashed[0];
    if (!stashedSession) throw new Error("expected a stashed session");

    const expiredStashed = { ...stashedSession, expiresAt: Date.now() - 1 };
    await service.saveSession(expiredStashed);

    await expect(service.getStashedSessions(entityId)).resolves.toEqual([]);
    await expect(service.restore(session.id, entityId)).rejects.toThrow(
      `Session not found: ${session.id}`,
    );
    await expect(
      service.updateField(session.id, entityId, "name", "Janet", 1, "manual"),
    ).rejects.toThrow(`Session not found: ${session.id}`);
  });
});

describe("form extraction hardening", () => {
  it("drops hostile extraction field names and clamps malformed confidence", () => {
    const parsed = parseFormExtractorOutput({
      formIntent: "fill_form",
      formExtractions: [
        { field: "__proto__", value: "x", confidence: 2 },
        { field: "constructor.name", value: "x", confidence: 0.8 },
        { field: "email", value: "jane@example.com", confidence: "bad" },
        { field: "age", value: "42", confidence: -10 },
      ],
    });

    expect(parsed?.extractions).toEqual([
      {
        field: "email",
        value: "jane@example.com",
        confidence: 0.5,
        reasoning: undefined,
        isCorrection: false,
      },
      {
        field: "age",
        value: "42",
        confidence: 0,
        reasoning: undefined,
        isCorrection: false,
      },
    ]);
  });

  it("filters unknown fields before evaluator processors mutate sessions", () => {
    const result = coerceExtractionsAgainstControls(
      [
        {
          field: "unknown",
          value: "ignored",
          confidence: 1,
          isCorrection: false,
        },
        { field: "age", value: "nope", confidence: 1, isCorrection: false },
        { field: "age", value: "42", confidence: 1, isCorrection: false },
      ],
      [{ key: "age", label: "Age", type: "number" }],
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ field: "age", confidence: 0.3 });
    // Rejected input keeps its original string rather than a NaN sentinel,
    // so the invalid status survives JSON session persistence.
    expect(result[0]?.value).toBe("nope");
    expect(result[1]).toMatchObject({
      field: "age",
      value: 42,
      confidence: 1,
    });
  });

  it("fuzzes malformed extraction fields without preserving unsafe paths", () => {
    const hostileFields = [
      "__proto__",
      "prototype",
      "constructor",
      "profile.__proto__",
      "profile..name",
      ".profile",
      "profile.",
    ];

    const parsed = parseFormExtractorOutput({
      formIntent: "fill_form",
      formExtractions: hostileFields.map((field, index) => ({
        field,
        value: `value-${index}`,
        confidence: index % 2 === 0 ? 100 : -100,
      })),
    });

    const coerced = coerceExtractionsAgainstControls(
      parsed?.extractions ?? [],
      [{ key: "profile", label: "Profile", type: "text" }],
    );

    expect(coerced).toEqual([]);
  });
});

describe("field validation edge cases", () => {
  it("rejects non-finite numbers", () => {
    const control = { key: "amount", label: "Amount", type: "number" };

    expect(validateField(Number.POSITIVE_INFINITY, control).valid).toBe(false);
    expect(validateField("Infinity", control).valid).toBe(false);
    expect(validateField("1e309", control).valid).toBe(false);
    expect(validateField("123", control).valid).toBe(true);
  });

  it("rejects trailing-garbage numeric strings instead of coercing them", () => {
    const control = { key: "amount", label: "Amount", type: "number" };

    // parseFloat stopped at the first non-numeric character and silently
    // coerced these to a wrong value; strict validation must reject them.
    for (const garbage of ["50abc", "0x10", "1.2.3", "12 apples", "5e3xyz"]) {
      expect(validateField(garbage, control).valid).toBe(false);
    }

    // The extraction path runs parseValue before validateField, so a
    // rejected input must not be silently coerced to a partial number.
    // parseValue keeps the ORIGINAL string (not a NaN/Infinity sentinel)
    // so the rejection survives session persistence, which round-trips
    // through JSON.parse(JSON.stringify(session)): JSON.stringify(NaN) is
    // "null", and a persisted null would pass the empty-optional rule at
    // submit-time revalidation and ride through as a healthy value.
    for (const garbage of ["50abc", "0x10", "1.2.3", "12 apples", "5e3xyz"]) {
      const parsed = parseValue(garbage, control);
      expect(parsed).toBe(garbage);
      const persisted = JSON.parse(JSON.stringify(parsed));
      expect(persisted).toBe(garbage);
      expect(validateField(persisted, control).valid).toBe(false);
    }

    // Overflow inputs match the numeric shape but become Infinity, which
    // also serializes to "null"; parseValue must keep the original string
    // for the same persistence reason.
    const overflow = parseValue("1e309", control);
    expect(overflow).toBe("1e309");
    expect(JSON.parse(JSON.stringify(overflow))).toBe("1e309");
    expect(validateField(overflow, control).valid).toBe(false);

    // A required number field rejects empty input as before.
    expect(validateField("", { ...control, required: true }).valid).toBe(false);
  });

  it("accepts a trailing decimal point without fractional digits", () => {
    const control = { key: "amount", label: "Amount", type: "number" };

    // Number("5.") is a complete finite number and develop's parseFloat
    // accepted it, so the strict shape must not narrow these to invalid.
    const accepted: Array<[string, number]> = [
      ["5.", 5],
      ["1.", 1],
      ["1.e3", 1000],
    ];
    for (const [input, expected] of accepted) {
      expect(validateField(input, control).valid).toBe(true);
      expect(parseValue(input, control)).toBe(expected);
    }

    // A bare dot is still not a number.
    expect(validateField(".", control).valid).toBe(false);
    expect(parseValue(".", control)).toBe(".");
  });

  it("still accepts legitimate numeric formats", () => {
    const control = { key: "amount", label: "Amount", type: "number" };

    const accepted: Array<[string, number]> = [
      ["1,234", 1234],
      ["$50", 50],
      ["-3.5", -3.5],
      [".5", 0.5],
      ["1e3", 1000],
    ];
    for (const [input, expected] of accepted) {
      expect(validateField(input, control).valid).toBe(true);
      expect(parseValue(input, control)).toBe(expected);
    }
  });
});

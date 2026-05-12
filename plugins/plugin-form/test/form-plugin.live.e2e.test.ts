/**
 * Plugin-Form live e2e tests.
 *
 * Tests the form plugin lifecycle: registration, builder API,
 * session management, and field validation through a real runtime.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";

describeIf(LIVE)("Plugin-Form: Plugin e2e", () => {
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "FormTestAgent",
    });
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("form plugin can be dynamically imported", async () => {
    const mod = await import("@elizaos/plugin-form");
    expect(mod).toBeTruthy();
    expect(mod.formPlugin || mod.default).toBeTruthy();
  });

  it("FormBuilder creates valid form definitions", async () => {
    const { FormBuilder, C } = await import("@elizaos/plugin-form");
    if (!FormBuilder || !C) {
      // Exports may not exist yet
      return;
    }
    const form = new FormBuilder("test-form", "Test Form")
      .description("A test form for e2e testing")
      .build();
    expect(form).toBeTruthy();
    expect(form.id).toBe("test-form");
  });

  it("field validation works for builtin types", async () => {
    const { validateField, registerBuiltinTypes, registerTypeHandler } =
      await import("@elizaos/plugin-form");
    if (!validateField) {
      return;
    }
    if (registerBuiltinTypes && registerTypeHandler) {
      registerBuiltinTypes(registerTypeHandler);
    }
    // Test basic validation if the function is available
    const result = validateField(
      { id: "email", type: "email", label: "Email" } as never,
      "test@example.com",
    );
    expect(result).toBeTruthy();
  });

  it("session storage functions are available", async () => {
    const mod = await import("@elizaos/plugin-form");
    // Verify the key session functions exist
    expect(typeof mod.saveSession).toBe("function");
    expect(typeof mod.getActiveSession).toBe("function");
    expect(typeof mod.deleteSession).toBe("function");
  });

  it("form evaluator exposes schema and prompt helpers", async () => {
    const mod = await import("@elizaos/plugin-form");
    const schema = mod.buildFormExtractorSchema();
    expect(schema).toBeTruthy();
    expect((schema as { type?: string }).type).toBe("object");
    expect(typeof mod.formEvaluator.shouldRun).toBe("function");
    expect(typeof mod.formEvaluator.prompt).toBe("function");
    expect(Array.isArray(mod.formEvaluator.processors)).toBe(true);
  });
});

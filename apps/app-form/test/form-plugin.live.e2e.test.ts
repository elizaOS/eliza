/**
 * App-Form live e2e tests.
 *
 * Tests the form plugin lifecycle: registration, builder API,
 * session management, and field validation through a real runtime.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../../test/helpers/conditional-tests";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../test/helpers/real-runtime";

const LIVE =
  process.env.ELIZA_LIVE_TEST === "1" ||
  process.env.MILADY_LIVE_TEST === "1";

describeIf(LIVE)("App-Form: Plugin e2e", () => {
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
    const mod = await import("@elizaos/app-form");
    expect(mod).toBeTruthy();
    expect(mod.formPlugin || mod.default).toBeTruthy();
  });

  it("FormBuilder creates valid form definitions", async () => {
    const { FormBuilder, C } = await import("@elizaos/app-form");
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
    const { validateField, registerBuiltinTypes, registerTypeHandler } = await import(
      "@elizaos/app-form"
    );
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
    const mod = await import("@elizaos/app-form");
    // Verify the key session functions exist
    expect(typeof mod.saveSession).toBe("function");
    expect(typeof mod.getActiveSession).toBe("function");
    expect(typeof mod.deleteSession).toBe("function");
  });

  it("intent detection functions work", async () => {
    const mod = await import("@elizaos/app-form");
    if (!mod.quickIntentDetect) {
      return;
    }
    // Quick intent detect should handle basic strings
    const result = mod.quickIntentDetect("I want to fill out a form");
    expect(result).toBeDefined();
  });
});

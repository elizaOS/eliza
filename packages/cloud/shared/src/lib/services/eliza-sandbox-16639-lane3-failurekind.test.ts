/**
 * Exercises the real host-service `message.send` failure ladder on
 * ElizaSandboxService while replacing only the sandbox-side fetch boundary.
 * The independent entry keeps fixture state isolated from the other sandbox
 * composites.
 */
import { describe, expect, test } from "bun:test";
import "./eliza-sandbox-bridge-failurekind.test.ts";

describe("eliza-sandbox composite lane 3 (bridge failureKind)", () => {
  test("runs under bun with its composed suite", () => {
    expect(typeof test).toBe("function");
  });
});

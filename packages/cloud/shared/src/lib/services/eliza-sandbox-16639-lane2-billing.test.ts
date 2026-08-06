/**
 * Runs the shared-runtime billing suite independently because its fetch and
 * WebSocketPair stubs bleed into the main suite's bridge cases when both share
 * one Bun process. The separate entry keeps those fixture boundaries intact.
 */
import { describe, expect, test } from "bun:test";
import "./eliza-sandbox-shared-billing.test.ts";

describe("eliza-sandbox composite lane 2 (shared billing)", () => {
  test("runs under bun with its composed suite", () => {
    expect(typeof test).toBe("function");
  });
});

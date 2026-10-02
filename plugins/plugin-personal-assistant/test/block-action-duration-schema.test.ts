/**
 * BLOCK's `durationMinutes` tells the model "Omit/null = indefinite until
 * manual removal", and both block handlers read an explicit null as
 * indefinite (`normalizeDurationMinutes` in app-block.ts / website-block.ts).
 * The declared schema must therefore admit null, or core tool-argument
 * validation rejects the call the description asks for.
 */

import { validateToolArgs } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { blockAction } from "../src/actions/block";

describe("BLOCK durationMinutes schema", () => {
  it("accepts the explicit null the description asks for and keeps it", () => {
    const result = validateToolArgs(blockAction, {
      action: "block",
      target: "app",
      durationMinutes: null,
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.args).toMatchObject({ durationMinutes: null });
  });

  it("still accepts a number and still rejects a non-number", () => {
    expect(
      validateToolArgs(blockAction, {
        action: "block",
        target: "website",
        durationMinutes: 30,
      }).valid,
    ).toBe(true);
    expect(
      validateToolArgs(blockAction, {
        action: "block",
        target: "app",
        durationMinutes: "x",
      }).valid,
    ).toBe(false);
  });
});

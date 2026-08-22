/** Verifies trajectory helpers preserve complete, well-formed prompt evidence. */
import { describe, expect, it } from "vitest";
import {
  capScriptForPersistence,
  truncateField,
  truncateRecord,
} from "./trajectory-internals.ts";

describe("lossless trajectory persistence", () => {
  it("preserves a large field beyond the legacy limit", () => {
    const input = `HEAD${"🦊".repeat(80_000)}TAIL`;
    const output = truncateField(input, 500);
    expect(output).toBe(input);
    expect(output.isWellFormed()).toBe(true);
  });

  it("preserves a large record instead of replacing it with a preview", () => {
    const record = {
      prompt: `HEAD${"x".repeat(150_000)}TAIL`,
      nested: { ok: true },
    };
    expect(truncateRecord(record, 500)).toBe(record);
  });

  it("preserves complete script source", () => {
    const script = `#!/bin/sh\n${"echo complete\n".repeat(20_000)}# END`;
    expect(capScriptForPersistence(script)).toEqual({ script });
  });
});

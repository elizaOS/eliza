/** Verifies trajectory helpers preserve complete prompt and script evidence. */
import { describe, expect, it } from "vitest";
import { capScriptForPersistence } from "./trajectory-internals.ts";

describe("lossless trajectory persistence", () => {
  it("preserves complete script source", () => {
    const script = `#!/bin/sh\n${"echo complete\n".repeat(20_000)}# END`;
    expect(capScriptForPersistence(script)).toEqual({ script });
  });
});

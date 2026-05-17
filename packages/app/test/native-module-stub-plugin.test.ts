import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { generateNodeBuiltinStub } from "../vite/native-module-stub-plugin";

describe("native module stub plugin", () => {
  it("preserves proxy invariants for generated builtin stubs", () => {
    const source = generateNodeBuiltinStub(
      "fs",
      createRequire(import.meta.url),
    );

    expect(source).toContain("ownKeys(t) { return Reflect.ownKeys(t); }");
    expect(source).toContain(
      "getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p)",
    );
    expect(source).toContain(
      "p === 'prototype' || p === 'name' || p === 'length'",
    );
    expect(source).not.toContain("ownKeys() { return []; }");
    expect(source).not.toContain("p === 'prototype') return {}");
  });
});

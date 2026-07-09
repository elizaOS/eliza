/**
 * Unit tests for the Native Module Stub Plugin app shell contract and coverage
 * guardrail.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  generateNodeBuiltinStub,
  nativeModuleStubPlugin,
} from "../vite/native-module-stub-plugin";

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

  it("exports Capacitor filesystem enums from the browser stub", () => {
    const plugin = nativeModuleStubPlugin({ isCapacitorMobileBuild: false });
    const id = plugin.resolveId?.("@capacitor/filesystem");
    expect(id).toBe("\0native-stub:@capacitor/filesystem");

    const source = plugin.load?.(id as string);
    expect(source).toContain("export const Directory");
    expect(source).toContain("Data: 'DATA'");
    expect(source).toContain("export const Encoding");
    expect(source).toContain("UTF8: 'utf8'");
    expect(source).toContain("export const Filesystem");
  });
});

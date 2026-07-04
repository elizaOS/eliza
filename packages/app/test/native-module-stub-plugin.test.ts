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

  it("exports named Capacitor attachment plugin stubs for web builds", () => {
    const plugin = nativeModuleStubPlugin({
      isCapacitorMobileBuild: false,
      requireModule: createRequire(import.meta.url),
    }) as unknown as {
      resolveId: (id: string) => string | null;
      load: (id: string) => string | null;
    };

    const filesystemId = plugin.resolveId("@capacitor/filesystem");
    const filesystemSource = plugin.load(filesystemId ?? "");
    expect(filesystemId).toBe("\0native-stub:@capacitor/filesystem");
    expect(filesystemSource).toContain("export { Filesystem };");
    expect(filesystemSource).not.toContain("writeFile");

    const shareId = plugin.resolveId("@capacitor/share");
    const shareSource = plugin.load(shareId ?? "");
    expect(shareId).toBe("\0native-stub:@capacitor/share");
    expect(shareSource).toContain("export { Share };");
    expect(shareSource).not.toContain("share:");
  });
});

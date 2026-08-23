import { describe, expect, it } from "vitest";
import {
  runtimeDocumentsEnabled,
  runtimeTrajectoriesEnabled,
} from "./native-runtime-features.ts";

describe("native-runtime-features", () => {
  it("returns true when the method exists and reports enabled", () => {
    const runtime = { isTrajectoriesEnabled: () => true } as never;
    expect(runtimeTrajectoriesEnabled(runtime)).toBe(true);
  });

  it("returns false when the method is absent", () => {
    expect(runtimeTrajectoriesEnabled({} as never)).toBe(false);
    expect(runtimeDocumentsEnabled({} as never)).toBe(false);
  });

  it("returns false when the method reports disabled", () => {
    const runtime = { isDocumentsEnabled: () => false } as never;
    expect(runtimeDocumentsEnabled(runtime)).toBe(false);
  });

  it("is tolerant of non-function flags", () => {
    const runtime = { isTrajectoriesEnabled: true } as never;
    expect(runtimeTrajectoriesEnabled(runtime)).toBe(false);
  });
});

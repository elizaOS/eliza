/**
 * Native-runtime feature tests exercise the production method-presence gates
 * with deterministic runtime doubles for enabled, absent, and invalid flags.
 */
import { describe, expect, it } from "vitest";
import {
  runtimeDocumentsEnabled,
  runtimeTrajectoriesEnabled,
} from "../native-runtime-features.ts";

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

describe("native-runtime-features remaining flag branches", () => {
  it("returns true for documents when the method exists and reports enabled", () => {
    const runtime = { isDocumentsEnabled: () => true } as never;
    expect(runtimeDocumentsEnabled(runtime)).toBe(true);
  });

  it("returns false for trajectories when the method reports disabled", () => {
    const runtime = { isTrajectoriesEnabled: () => false } as never;
    expect(runtimeTrajectoriesEnabled(runtime)).toBe(false);
  });

  it("returns false when a documents flag holds a truthy non-function value", () => {
    const runtime = { isDocumentsEnabled: "yes" } as never;
    expect(runtimeDocumentsEnabled(runtime)).toBe(false);
  });

  it("returns false when a trajectories flag property is null", () => {
    const runtime = { isTrajectoriesEnabled: null } as never;
    expect(runtimeTrajectoriesEnabled(runtime)).toBe(false);
  });

  it("propagates falsy method returns without coercing them to false", () => {
    const undefinedRuntime = {
      isTrajectoriesEnabled: () => undefined,
    } as never;
    expect(runtimeTrajectoriesEnabled(undefinedRuntime)).toBeUndefined();
    const zeroRuntime = { isDocumentsEnabled: () => 0 } as never;
    expect(runtimeDocumentsEnabled(zeroRuntime)).toBe(0);
    const emptyStringRuntime = { isTrajectoriesEnabled: () => "" } as never;
    expect(runtimeTrajectoriesEnabled(emptyStringRuntime)).toBe("");
  });

  it("propagates a truthy non-boolean return as-is", () => {
    const runtime = { isTrajectoriesEnabled: () => "enabled" } as never;
    expect(runtimeTrajectoriesEnabled(runtime)).toBe("enabled");
  });
});

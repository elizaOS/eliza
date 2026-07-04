/**
 * Unit coverage for the crash-injection fault harness: spec parsing, the
 * production safety gate (disarmed unless explicitly allowed), and per-point
 * fault firing (throw/exit/restart/hang, fire-at-most-once). process.exit is
 * spied, not called; no real process termination.
 */
import { RESTART_EXIT_CODE as SHARED_RESTART_EXIT_CODE } from "@elizaos/shared/restart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armCrashInjection,
  isCrashInjectionArmed,
  maybeInjectFault,
  parseCrashInjectionSpec,
  RESTART_EXIT_CODE,
  resetCrashInjectionForTests,
  resolveCrashInjectionConfig,
} from "./crash-injection.ts";

beforeEach(() => {
  resetCrashInjectionForTests();
});
afterEach(() => {
  resetCrashInjectionForTests();
  vi.restoreAllMocks();
});

describe("parseCrashInjectionSpec", () => {
  it("returns an empty config for empty/undefined input", () => {
    expect(parseCrashInjectionSpec(undefined).size).toBe(0);
    expect(parseCrashInjectionSpec("").size).toBe(0);
    expect(parseCrashInjectionSpec("   ").size).toBe(0);
  });

  it("parses point:mode:arg triples", () => {
    const cfg = parseCrashInjectionSpec("boot:exit:7,steady:hang:5000");
    expect(cfg.get("boot")).toEqual({ mode: "exit", arg: 7 });
    expect(cfg.get("steady")).toEqual({ mode: "hang", arg: 5000 });
  });

  it("defaults the mode to exit when omitted", () => {
    expect(parseCrashInjectionSpec("boot").get("boot")).toEqual({
      mode: "exit",
      arg: undefined,
    });
  });

  it("skips unknown points and falls back to exit for unknown modes", () => {
    const cfg = parseCrashInjectionSpec("bogus:throw,model-load:nonsense");
    expect(cfg.has("model-load")).toBe(true);
    expect(cfg.get("model-load")?.mode).toBe("exit");
    // an unknown point name is not a valid key
    expect([...cfg.keys()]).not.toContain("bogus");
  });
});

describe("resolveCrashInjectionConfig — production safety gate", () => {
  it("is disarmed when ELIZA_CRASH_INJECT is unset", () => {
    expect(resolveCrashInjectionConfig({}).size).toBe(0);
  });

  it("arms in a non-production runtime", () => {
    const cfg = resolveCrashInjectionConfig({
      ELIZA_CRASH_INJECT: "boot:throw",
      NODE_ENV: "test",
    });
    expect(cfg.get("boot")?.mode).toBe("throw");
  });

  it("REFUSES to arm in production without the explicit allow flag", () => {
    expect(
      resolveCrashInjectionConfig({
        ELIZA_CRASH_INJECT: "boot:exit",
        NODE_ENV: "production",
      }).size,
    ).toBe(0);
    expect(
      resolveCrashInjectionConfig({
        ELIZA_CRASH_INJECT: "boot:exit",
        ELIZA_BUILD_VARIANT: "production",
      }).size,
    ).toBe(0);
  });

  it("arms in production only with ELIZA_ALLOW_CRASH_INJECT=1", () => {
    const cfg = resolveCrashInjectionConfig({
      ELIZA_CRASH_INJECT: "boot:exit",
      NODE_ENV: "production",
      ELIZA_ALLOW_CRASH_INJECT: "1",
    });
    expect(cfg.get("boot")?.mode).toBe("exit");
  });
});

describe("maybeInjectFault", () => {
  it("re-exports the shared restart exit code", () => {
    expect(RESTART_EXIT_CODE).toBe(SHARED_RESTART_EXIT_CODE);
  });

  it("is a no-op when disarmed", () => {
    armCrashInjection({});
    expect(isCrashInjectionArmed()).toBe(false);
    expect(() => maybeInjectFault("boot")).not.toThrow();
  });

  it("does not fire at points other than the configured one", () => {
    armCrashInjection({ ELIZA_CRASH_INJECT: "steady:throw", NODE_ENV: "test" });
    expect(() => maybeInjectFault("boot")).not.toThrow();
    expect(() => maybeInjectFault("steady")).toThrow(
      /injected throw at "steady"/,
    );
  });

  it("calls process.exit(1) for exit mode", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    armCrashInjection({ ELIZA_CRASH_INJECT: "boot:exit", NODE_ENV: "test" });
    maybeInjectFault("boot");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits with RESTART_EXIT_CODE for restart mode", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    armCrashInjection({
      ELIZA_CRASH_INJECT: "native-bridge:restart",
      NODE_ENV: "test",
    });
    maybeInjectFault("native-bridge");
    expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE);
  });

  it("fires a point at most once (no storm)", () => {
    armCrashInjection({ ELIZA_CRASH_INJECT: "steady:throw", NODE_ENV: "test" });
    expect(() => maybeInjectFault("steady")).toThrow();
    // already tripped -> no-op the second time
    expect(() => maybeInjectFault("steady")).not.toThrow();
  });

  it("returns a never-resolving promise for hang mode", async () => {
    armCrashInjection({
      ELIZA_CRASH_INJECT: "model-load:hang",
      NODE_ENV: "test",
    });
    const hang = maybeInjectFault("model-load");
    expect(hang).toBeInstanceOf(Promise);
    const settled = await Promise.race([
      (hang as Promise<never>).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-hanging"), 30)),
    ]);
    expect(settled).toBe("still-hanging");
  });
});

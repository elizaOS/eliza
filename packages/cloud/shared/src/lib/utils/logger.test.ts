/** Exercises the real cloud logging sink and redaction, including quiet-mode audit delivery. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { logger } from "./logger";

/**
 * Proves #12229 M6: the cloud logger redacts at the sink, so a secret is masked
 * whether or not the caller wrapped context in `redact.context()`. Runs against
 * the real logger, capturing `console.error/warn` — no mock of the redactor.
 */
describe("cloud logger sink redaction (#12229 M6)", () => {
  const original = { error: console.error, warn: console.warn };

  afterEach(() => {
    console.error = original.error;
    console.warn = original.warn;
  });

  test("masks a value under a credential-named key with no redact.context()", () => {
    const calls: unknown[][] = [];
    console.error = mock((...args: unknown[]) => {
      calls.push(args);
    });

    logger.error("boot failed", {
      apiKey: "eliza_supersecretvalue1234567890",
      userId: "u-1",
    });

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("eliza_supersecretvalue1234567890");
    expect(serialized).toContain("[REDACTED]");
    // Non-secret context is preserved.
    expect(serialized).toContain("u-1");
  });

  test("masks a value-shaped secret in a plain string argument", () => {
    const calls: unknown[][] = [];
    console.error = mock((...args: unknown[]) => {
      calls.push(args);
    });

    logger.error("key is sk-abcdefghijklmnop1234 leaked");

    expect(JSON.stringify(calls)).not.toContain("sk-abcdefghijklmnop1234");
  });

  test("redact.context() still works and agrees with the sink predicate", () => {
    const ctx = logger.redact.context({
      password: "hunter2-supersecret-value",
      count: 3,
    });
    expect(ctx.password).toBe("[REDACTED]");
    expect(ctx.count).toBe(3);
  });

  test("audit evidence survives quiet production logging without exposing secrets", () => {
    const moduleUrl = new URL("./logger.ts", import.meta.url).href;
    const script = `const { logger } = await import(${JSON.stringify(moduleUrl)});
      logger.info("verbose-only-sentinel", { value: 1 });
      logger.audit("[InferenceAuth] trace", { result: "authorized_cache", apiKey: "private-audit-secret" });`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, NODE_ENV: "production", VERBOSE_LOGGING: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const output = child.stdout.toString();
    expect(output).toContain("[InferenceAuth] trace");
    expect(output).toContain("authorized_cache");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("private-audit-secret");
    expect(output).not.toContain("verbose-only-sentinel");
  });
});

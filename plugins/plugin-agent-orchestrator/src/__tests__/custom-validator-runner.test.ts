/**
 * Tests for the custom validator runner.
 *
 * The runner resolves `runtime.getService(spec.service)`, calls the named
 * method with the supplied params (plus optional structuredProof), and
 * normalizes the response into `{ verdict, retryablePromptForChild }`.
 * Every failure path collapses into `verdict: "fail"` so the orchestrator
 * decision loop never crashes on a misconfigured spec.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CustomValidatorSpec,
  getMaxRetries,
  runCustomValidator,
} from "../services/custom-validator-runner.js";

interface FakeServiceMap {
  [name: string]: Record<string, unknown> | undefined;
}

function createRuntime(services: FakeServiceMap): IAgentRuntime {
  return {
    getService: (name: string) => services[name] ?? null,
  } as unknown as IAgentRuntime;
}

const SPEC: CustomValidatorSpec = {
  service: "app-verification",
  method: "verifyApp",
  params: { appId: "abc-123", workdir: "/tmp/abc" },
};

describe("runCustomValidator", () => {
  it("returns pass when the validator service returns verdict=pass", async () => {
    const verifyApp = vi.fn(async () => ({
      verdict: "pass" as const,
      retryablePromptForChild: "(no follow-up needed)",
      checks: [{ name: "package.json", ok: true }],
    }));
    const runtime = createRuntime({
      "app-verification": { verifyApp },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("pass");
    expect(result.retryablePromptForChild).toBe("(no follow-up needed)");
    expect(verifyApp).toHaveBeenCalledTimes(1);
    expect(verifyApp).toHaveBeenCalledWith({
      appId: "abc-123",
      workdir: "/tmp/abc",
    });
    expect(result.details).toMatchObject({ verdict: "pass" });
  });

  it("forwards structuredProof under params.structuredProof", async () => {
    const verifyApp = vi.fn(async () => ({
      verdict: "pass" as const,
      retryablePromptForChild: "ok",
    }));
    const runtime = createRuntime({
      "app-verification": { verifyApp },
    });
    const proof = { name: "demo-app", files: ["src/plugin.ts"] };

    await runCustomValidator(runtime, SPEC, proof);

    expect(verifyApp).toHaveBeenCalledWith({
      appId: "abc-123",
      workdir: "/tmp/abc",
      structuredProof: proof,
    });
  });

  it("returns fail with the validator-supplied retry prompt", async () => {
    const verifyApp = vi.fn(async () => ({
      verdict: "fail" as const,
      retryablePromptForChild:
        "package.json is missing a `name` field. Add it and re-run tests, then re-emit APP_CREATE_DONE.",
      checks: [{ name: "package.json", ok: false }],
    }));
    const runtime = createRuntime({
      "app-verification": { verifyApp },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toContain("`name` field");
    expect(result.details).toMatchObject({ verdict: "fail" });
  });

  it("returns fail when the validator service is not registered", async () => {
    const runtime = createRuntime({});
    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toContain(
      "'app-verification' is not registered",
    );
  });

  it("returns fail when the requested method is missing on the service", async () => {
    const runtime = createRuntime({
      "app-verification": {
        verifyOther: () => ({ verdict: "pass" }),
      },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toContain(
      "no callable method 'verifyApp'",
    );
  });

  it("returns fail and surfaces the message when the validator throws", async () => {
    const verifyApp = vi.fn(async () => {
      throw new Error("pglite probe timed out");
    });
    const runtime = createRuntime({
      "app-verification": { verifyApp },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toContain("pglite probe timed out");
  });

  it("returns fail when the validator returns a non-object payload", async () => {
    const runtime = createRuntime({
      "app-verification": { verifyApp: async () => "ok" },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toContain("non-object result");
  });

  it("returns fail when the validator returns an unrecognized verdict", async () => {
    const runtime = createRuntime({
      "app-verification": {
        verifyApp: async () => ({
          verdict: "maybe",
          retryablePromptForChild: "?",
        }),
      },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toContain("invalid verdict");
  });

  it("falls back to followUpPrompt when retryablePromptForChild is missing", async () => {
    const runtime = createRuntime({
      "app-verification": {
        verifyApp: async () => ({
          verdict: "fail" as const,
          followUpPrompt: "tighten the lockfile and re-run",
        }),
      },
    });

    const result = await runCustomValidator(runtime, SPEC);

    expect(result.verdict).toBe("fail");
    expect(result.retryablePromptForChild).toBe(
      "tighten the lockfile and re-run",
    );
  });
});

describe("getMaxRetries", () => {
  const ORIGINAL = process.env.ELIZA_APP_VERIFICATION_MAX_RETRIES;

  function withEnv(value: string | undefined, fn: () => void): void {
    if (value === undefined) {
      delete process.env.ELIZA_APP_VERIFICATION_MAX_RETRIES;
    } else {
      process.env.ELIZA_APP_VERIFICATION_MAX_RETRIES = value;
    }
    try {
      fn();
    } finally {
      if (ORIGINAL === undefined) {
        delete process.env.ELIZA_APP_VERIFICATION_MAX_RETRIES;
      } else {
        process.env.ELIZA_APP_VERIFICATION_MAX_RETRIES = ORIGINAL;
      }
    }
  }

  it("prefers a non-negative task override over env and default", () => {
    withEnv("9", () => {
      expect(getMaxRetries(2)).toBe(2);
      expect(getMaxRetries(0)).toBe(0);
    });
  });

  it("falls through to env when override is undefined or negative", () => {
    withEnv("7", () => {
      expect(getMaxRetries(undefined)).toBe(7);
      expect(getMaxRetries(-1)).toBe(7);
    });
  });

  it("uses the documented default (3) when env is missing or invalid", () => {
    withEnv(undefined, () => {
      expect(getMaxRetries()).toBe(3);
    });
    withEnv("not-a-number", () => {
      expect(getMaxRetries()).toBe(3);
    });
  });
});

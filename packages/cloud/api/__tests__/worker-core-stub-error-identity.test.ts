/**
 * The Worker bundle aliases `@elizaos/core` to the hand-written worker-safe
 * mirror in `src/stubs/elizaos-core.ts` (wrangler.toml `[alias]`), but that
 * alias is exact — `@elizaos/core/errors` keeps resolving to the real module.
 * Both `ElizaError` classes therefore ship in one bundle, and code that throws
 * through one while narrowing through the other used to fall through.
 *
 * `packages/cloud/shared/src/lib/utils/owned-bounded-fetch.ts` (subpath) and
 * `twilio-api.ts` (barrel) are exactly that pairing, and both are in the
 * shipped bundle.
 */

import { describe, expect, test } from "bun:test";
import * as realCoreErrors from "@elizaos/core/errors";
import * as workerCoreStub from "../src/stubs/elizaos-core";

describe("worker core stub / real core error identity", () => {
  const boundedBodyFailure = () =>
    new realCoreErrors.ElizaError(
      "REST response exceeds its bounded-body contract",
      {
        code: "CLOUD_REST_RESPONSE_TOO_LARGE",
        context: { maxResponseBytes: 4 * 1024 * 1024 },
        severity: "ephemeral",
      },
    );

  test("the two classes really are distinct", () => {
    expect(workerCoreStub.ElizaError).not.toBe(realCoreErrors.ElizaError);
    expect(boundedBodyFailure() instanceof workerCoreStub.ElizaError).toBe(
      false,
    );
  });

  test("the stub narrows an error thrown by the real module", () => {
    // twilio-api.ts's `if (isElizaError(cause)) throw cause;` pass-through.
    expect(workerCoreStub.isElizaError(boundedBodyFailure())).toBe(true);
  });

  test("the real module narrows an error thrown by the stub", () => {
    const fromStub = new workerCoreStub.ElizaError("stub failure", {
      code: "STUB",
    });
    expect(realCoreErrors.isElizaError(fromStub)).toBe(true);
  });

  test("the stub does not relabel a real-module error as UNCLASSIFIED", () => {
    const failure = boundedBodyFailure();
    const normalized = workerCoreStub.toElizaError(failure);
    expect(normalized).toBe(failure);
    expect(normalized.code).toBe("CLOUD_REST_RESPONSE_TOO_LARGE");
    expect(normalized.severity).toBe("ephemeral");
  });

  test("neither side brands unrelated values", () => {
    expect(workerCoreStub.isElizaError(new Error("plain"))).toBe(false);
    expect(realCoreErrors.isElizaError({ code: "X" })).toBe(false);
  });
});

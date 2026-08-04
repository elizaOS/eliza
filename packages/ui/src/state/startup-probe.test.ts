/** Classifies optional startup endpoint outcomes at the HTTP/runtime boundary. */

import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client-types-core";
import {
  runStartupProbe,
  runStartupProbeWithTimeout,
  StartupProbeTimeoutError,
  unwrapStartupProbe,
} from "./startup-probe";

function apiError(
  kind: "network" | "timeout" | "http" | "parse",
  status?: number,
) {
  return new ApiError({ kind, status, path: "/probe", message: kind });
}

describe("runStartupProbe", () => {
  it("preserves successful values", async () => {
    await expect(runStartupProbe(async () => 42)).resolves.toEqual({
      kind: "ok",
      value: 42,
    });
  });

  it("treats only explicitly allowed 404 responses as unsupported", async () => {
    const error = apiError("http", 404);
    await expect(
      runStartupProbe(async () => Promise.reject(error), {
        unsupportedStatuses: [404],
      }),
    ).resolves.toEqual({ kind: "unsupported", error });
    await expect(
      runStartupProbe(async () => Promise.reject(error)),
    ).resolves.toEqual({ kind: "terminal-error", error });
  });

  it.each([
    apiError("network"),
    apiError("timeout"),
    apiError("http", 429),
    apiError("http", 503),
  ])("keeps transient failures retryable", async (error) => {
    await expect(
      runStartupProbe(async () => Promise.reject(error)),
    ).resolves.toEqual({ kind: "retryable-error", error });
  });

  it("keeps parse and non-optional client failures terminal", async () => {
    const parseError = apiError("parse", 200);
    const clientError = apiError("http", 403);
    expect(
      (await runStartupProbe(async () => Promise.reject(parseError))).kind,
    ).toBe("terminal-error");
    expect(
      (await runStartupProbe(async () => Promise.reject(clientError))).kind,
    ).toBe("terminal-error");
    expect(() =>
      unwrapStartupProbe({ kind: "terminal-error", error: clientError }),
    ).toThrow(clientError);
  });

  it("represents a bounded probe timeout as a retryable error", async () => {
    const result = await runStartupProbeWithTimeout(
      () => new Promise<number>(() => undefined),
      1,
    );
    expect(result.kind).toBe("retryable-error");
    if (result.kind === "retryable-error") {
      expect(result.error).toBeInstanceOf(StartupProbeTimeoutError);
    }
  });
});

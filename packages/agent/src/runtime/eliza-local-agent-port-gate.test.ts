/**
 * Verifies the `ELIZA_API_EXPOSE_PORT` gate that keeps `startEliza`'s API port
 * closed under Android local-agent (stdio) mode unless explicitly re-exposed
 * (#12352, #12180). Deterministic and boot-free: the typed boot plan is driven
 * directly.
 */
import { describe, expect, it } from "vitest";
import {
  captureAgentEnvironment,
  resolveBootPlan,
  resolveBootPolicy,
} from "./boot-pipeline.ts";

function shouldSkipApiListen(
  localAgentMode: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  const environment = captureAgentEnvironment(env);
  const policy = resolveBootPolicy(environment);
  return !resolveBootPlan({
    localAgentMode,
    configured: true,
    cloudThinClient: false,
    apiExposePort: policy.apiExposePort,
  }).bindApiListener;
}

describe("agent local-agent IPC port gate (#12352)", () => {
  it("skips the listener only when localAgentMode is true and the port is not force-exposed", () => {
    expect(shouldSkipApiListen(true, {})).toBe(true);
  });

  it("binds the port when localAgentMode is unset (default server-only boot)", () => {
    expect(shouldSkipApiListen(undefined, {})).toBe(false);
    expect(shouldSkipApiListen(false, {})).toBe(false);
  });

  it("binds the port in local-agent mode when ELIZA_API_EXPOSE_PORT opts back in", () => {
    expect(shouldSkipApiListen(true, { ELIZA_API_EXPOSE_PORT: "1" })).toBe(
      false,
    );
    expect(shouldSkipApiListen(true, { ELIZA_API_EXPOSE_PORT: "true" })).toBe(
      false,
    );
  });
});

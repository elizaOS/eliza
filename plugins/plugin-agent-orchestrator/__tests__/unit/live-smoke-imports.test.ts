/**
 * Import-shape regression guard for the out-of-tree live coding harness
 * (`packages/core/test/live/task-agent-live-smoke.ts`) and the live e2e that
 * drives it (`src/__tests__/task-agent-live.e2e.test.ts`).
 *
 * Those live runs are skipped unless `ORCHESTRATOR_LIVE=1` + real auth, so CI
 * never exercises their imports — which is how the harness silently rotted when
 * `PTYService` and `cleanForChat` were dropped from the public surface (the
 * smoke script kept importing removed symbols and would crash on the first live
 * run). This *non-live* test asserts every symbol that harness imports + uses
 * still exists with the right shape, so the drift fails fast in the normal unit
 * lane instead of on a costly live run.
 *
 * If you intentionally rename/remove one of these, update the live smoke script
 * AND this guard together.
 */

import { describe, expect, it } from "vitest";
import {
  AcpService,
  cleanForChat,
  getAcpService,
  listAgentsAction,
  sendToAgentAction,
  spawnAgentAction,
} from "../../src/index.js";

describe("live coding harness import surface", () => {
  it("exposes AcpService with the start+register+output API the smoke script uses", () => {
    expect(typeof AcpService).toBe("function");
    // `AcpService.start(runtime)` + `runtime.services.set(AcpService.serviceType, …)`
    expect(typeof AcpService.start).toBe("function");
    expect(AcpService.serviceType).toBe("ACP_SUBPROCESS_SERVICE");
    // Instance methods the smoke script calls on the started service.
    for (const method of [
      "onSessionEvent",
      "checkAvailableAgents",
      "getSession",
      "getSessionOutput",
      "spawnSession",
      "stopSession",
    ]) {
      expect(
        typeof (AcpService.prototype as Record<string, unknown>)[method],
        `AcpService.prototype.${method}`,
      ).toBe("function");
    }
  });

  it("exposes the terminal-output + service-resolution helpers", () => {
    expect(typeof cleanForChat).toBe("function");
    expect(typeof getAcpService).toBe("function");
  });

  it("exposes the TASKS actions the smoke script drives", () => {
    for (const action of [
      spawnAgentAction,
      sendToAgentAction,
      listAgentsAction,
    ]) {
      expect(action, "action export").toBeTruthy();
      expect(typeof action.name).toBe("string");
      expect(typeof action.handler).toBe("function");
    }
  });
});

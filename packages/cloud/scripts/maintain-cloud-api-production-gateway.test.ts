/**
 * The production gateway maintainer may only redeploy when the verifier exits
 * with the explicit drift code; signals, timeouts, spawn failures, and ordinary
 * verifier errors must fail without deploying.
 */
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CONTRACT_DRIFT_EXIT_CODE } from "./lib/cloud-api-gateway-contract.ts";
import {
  childRunResult,
  maintainGateway,
} from "./maintain-cloud-api-production-gateway.ts";

const quiet = { log: () => {}, write: () => {} };

function spawnResult(overrides) {
  return childRunResult({
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  });
}

describe("maintainGateway", () => {
  it("treats a signal-killed child as a failure, not success", () => {
    const result = spawnResult({ status: null, signal: "SIGTERM" });
    expect(result.status).toBeNull();
    expect(result.failure).toBe("terminated by SIGTERM");
  });

  it("does not deploy when the verifier is killed by a signal", () => {
    const deploy = vi.fn();
    expect(() =>
      maintainGateway({
        verify: () => spawnResult({ status: null, signal: "SIGKILL" }),
        deploy,
        ...quiet,
      }),
    ).toThrow(/terminated by SIGKILL.*not deploying/);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("does not deploy when the verifier fails for a non-drift reason", () => {
    const deploy = vi.fn();
    expect(() =>
      maintainGateway({
        verify: () => spawnResult({ status: 1, stderr: "fetch failed" }),
        deploy,
        ...quiet,
      }),
    ).toThrow(/exit 1.*not deploying/);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("does not deploy when the verifier cannot be spawned", () => {
    const deploy = vi.fn();
    expect(() =>
      maintainGateway({
        verify: () =>
          spawnResult({ status: null, error: new Error("spawn node ENOENT") }),
        deploy,
        ...quiet,
      }),
    ).toThrow(/spawn failed: spawn node ENOENT/);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("passes without deploying when the contract holds", () => {
    const deploy = vi.fn();
    expect(
      maintainGateway({ verify: () => spawnResult({}), deploy, ...quiet }),
    ).toEqual({ repaired: false });
    expect(deploy).not.toHaveBeenCalled();
  });

  it("deploys only on the explicit drift exit code", () => {
    const deploy = vi.fn(() => spawnResult({}));
    expect(
      maintainGateway({
        verify: () => spawnResult({ status: GATEWAY_CONTRACT_DRIFT_EXIT_CODE }),
        deploy,
        ...quiet,
      }),
    ).toEqual({ repaired: true });
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it("fails when the repair deploy is killed by a signal", () => {
    expect(() =>
      maintainGateway({
        verify: () => spawnResult({ status: GATEWAY_CONTRACT_DRIFT_EXIT_CODE }),
        deploy: () => spawnResult({ status: null, signal: "SIGTERM" }),
        ...quiet,
      }),
    ).toThrow(/repair deploy failed \(terminated by SIGTERM\)/);
  });
});

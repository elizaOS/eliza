import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type DevTrajectoryRecoveryOwner,
  MAX_DEV_RECOVERY_OWNERS,
  parseDevTrajectoryRecoveryChildMessage,
  parseDevTrajectoryRecoveryParentMessage,
  sameDevTrajectoryRecoveryOwner,
  sameDevTrajectoryRecoveryScope,
} from "./dev-trajectory-recovery-protocol.ts";

function owner(): DevTrajectoryRecoveryOwner {
  return {
    agentId: randomUUID(),
    runtimeInstanceId: randomUUID(),
    runtimeExecutionOwnerId: randomUUID(),
    storageScope: {
      kind: "pglite",
      realPath: "/tmp/private-pglite",
      device: "1",
      inode: "42",
    },
  };
}

describe("dev trajectory recovery protocol", () => {
  it("accepts versioned registration and recovery acknowledgement messages", () => {
    const current = owner();
    const previous = { ...current, runtimeExecutionOwnerId: randomUUID() };
    const registration = {
      type: "eliza:trajectory-recovery:register",
      version: 1,
      requestId: "request-1",
      owner: current,
    };
    expect(parseDevTrajectoryRecoveryChildMessage(registration)).toEqual(
      registration,
    );
    const registered = {
      type: "eliza:trajectory-recovery:registered",
      version: 1,
      requestId: "request-1",
      owner: current,
      recoveryBatchId: "batch-1",
      owners: [previous],
    };
    expect(parseDevTrajectoryRecoveryParentMessage(registered)).toEqual(
      registered,
    );
    const recovered = {
      type: "eliza:trajectory-recovery:recovered",
      version: 1,
      requestId: "request-2",
      recoveryBatchId: "batch-1",
    };
    expect(parseDevTrajectoryRecoveryChildMessage(recovered)).toEqual(
      recovered,
    );
    const acknowledged = {
      ...recovered,
      type: "eliza:trajectory-recovery:acknowledged",
    };
    expect(parseDevTrajectoryRecoveryParentMessage(acknowledged)).toEqual(
      acknowledged,
    );
  });

  it.each([
    { version: 2 },
    { requestId: "" },
    { requestId: "x".repeat(129) },
    { owner: null },
    { owner: { ...owner(), runtimeExecutionOwnerId: "inherited-setting" } },
    {
      owner: {
        ...owner(),
        storageScope: {
          kind: "pglite",
          realPath: "relative",
          device: "1",
          inode: "2",
        },
      },
    },
  ])("rejects malformed or unbounded registration fields %j", (override) => {
    expect(
      parseDevTrajectoryRecoveryChildMessage({
        type: "eliza:trajectory-recovery:register",
        version: 1,
        requestId: "request",
        owner: owner(),
        ...override,
      }),
    ).toBeNull();
  });

  it("rejects excessive recovery owners and duplicate execution tokens", () => {
    const current = owner();
    const previous = owner();
    const registered = {
      type: "eliza:trajectory-recovery:registered",
      version: 1,
      requestId: "request",
      owner: current,
      recoveryBatchId: "batch",
    };
    expect(
      parseDevTrajectoryRecoveryParentMessage({
        ...registered,
        owners: [previous, previous],
      }),
    ).toBeNull();
    expect(
      parseDevTrajectoryRecoveryParentMessage({
        ...registered,
        owners: Array.from({ length: MAX_DEV_RECOVERY_OWNERS + 1 }, owner),
      }),
    ).toBeNull();
  });

  it("compares the storage and installation scope independently of execution identity", () => {
    const current = owner();
    const next = { ...current, runtimeExecutionOwnerId: randomUUID() };
    expect(sameDevTrajectoryRecoveryScope(current, next)).toBe(true);
    expect(sameDevTrajectoryRecoveryOwner(current, next)).toBe(false);
    expect(
      sameDevTrajectoryRecoveryOwner(current, structuredClone(current)),
    ).toBe(true);
    for (const other of [
      { ...next, agentId: randomUUID() },
      { ...next, runtimeInstanceId: randomUUID() },
      { ...next, storageScope: { ...next.storageScope, inode: "43" } },
      { ...next, storageScope: { ...next.storageScope, device: "2" } },
      {
        ...next,
        storageScope: { ...next.storageScope, realPath: "/tmp/other" },
      },
    ])
      expect(sameDevTrajectoryRecoveryScope(current, other)).toBe(false);
  });
});

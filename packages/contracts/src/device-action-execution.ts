/** Renderer-side attempt fencing. A native or host journal still owns durable
 * admission and recovery; this guard never grants approval or retry permission. */
export interface DeviceActionExecutionIdentity {
  readonly scope: string;
  readonly proposalId: string;
  readonly operationId: string;
}

export function deviceActionExecutionIdentity(
  value: unknown,
): Readonly<DeviceActionExecutionIdentity> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid device action execution identity");
  const input = value as Record<string, unknown>;
  if (
    typeof input.scope !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.scope) ||
    ![input.proposalId, input.operationId].every(
      (id) => typeof id === "string" && /^[-A-Za-z0-9_]{1,128}$/.test(id),
    )
  )
    throw Error("Invalid device action execution identity");
  return Object.freeze({
    scope: input.scope,
    proposalId: input.proposalId as string,
    operationId: input.operationId as string,
  });
}

/** One renderer attempt. The caller must obtain durable/native admission before
 * dispatch. Retirement forbids a new dispatch; it does not erase
 * a result already produced by the journaled/native attempt. Create another
 * guard only after the authoritative journal admits that separate attempt. */
export function createDeviceActionExecution(
  value: unknown,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  const identity = deviceActionExecutionIdentity(value);
  let phase: "prepared" | "dispatched" | "settled" = "prepared";
  let retired = false;
  const assertIdentity = (candidate: unknown) => {
    const actual = deviceActionExecutionIdentity(candidate);
    if (
      actual.scope !== identity.scope ||
      actual.proposalId !== identity.proposalId ||
      actual.operationId !== identity.operationId
    )
      throw Error("Device action execution identity changed");
  };
  const assertPrepared = () => {
    signal.throwIfAborted();
    if (retired || phase !== "prepared")
      throw Error("Device action is no longer available for dispatch");
    assertCurrent();
  };
  return {
    identity,
    assertIdentity,
    assertPrepared,
    get dispatched() {
      return phase !== "prepared";
    },
    markDispatched(candidate: unknown) {
      assertIdentity(candidate);
      assertPrepared();
      phase = "dispatched";
    },
    settle(candidate: unknown) {
      assertIdentity(candidate);
      if (phase !== "dispatched")
        throw Error("Device action has no unsettled dispatch");
      phase = "settled";
    },
    retire() {
      retired = true;
    },
  };
}

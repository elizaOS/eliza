/** Bounded IPC messages for recovery authorized by a surviving dev supervisor. */
export const DEV_TRAJECTORY_RECOVERY_VERSION = 1;
export const MAX_DEV_RECOVERY_OWNERS = 256;
export const MAX_DEV_RECOVERY_CHILD_OWNERS = 64;

export interface DevTrajectoryRecoveryStorageScope {
  kind: "pglite";
  realPath: string;
  device: string;
  inode: string;
}

export interface DevTrajectoryRecoveryOwner {
  agentId: string;
  runtimeInstanceId: string;
  runtimeExecutionOwnerId: string;
  storageScope: DevTrajectoryRecoveryStorageScope;
}

interface MessageBase {
  version: typeof DEV_TRAJECTORY_RECOVERY_VERSION;
  requestId: string;
}

export type DevTrajectoryRecoveryChildMessage =
  | (MessageBase & {
      type: "eliza:trajectory-recovery:register";
      owner: DevTrajectoryRecoveryOwner;
    })
  | (MessageBase & {
      type: "eliza:trajectory-recovery:recovered";
      recoveryBatchId: string;
    });

export type DevTrajectoryRecoveryParentMessage =
  | (MessageBase & {
      type: "eliza:trajectory-recovery:registered";
      owner: DevTrajectoryRecoveryOwner;
      recoveryBatchId: string;
      owners: DevTrajectoryRecoveryOwner[];
    })
  | (MessageBase & {
      type: "eliza:trajectory-recovery:acknowledged";
      recoveryBatchId: string;
    })
  | (MessageBase & {
      type: "eliza:trajectory-recovery:rejected";
      reason: string;
    });

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

export function parseDevTrajectoryRecoveryOwner(
  value: unknown,
): DevTrajectoryRecoveryOwner | null {
  const owner = record(value);
  const scope = record(owner?.storageScope);
  if (
    !owner ||
    !scope ||
    !boundedText(owner.agentId) ||
    !boundedText(owner.runtimeInstanceId) ||
    !boundedText(owner.runtimeExecutionOwnerId) ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      owner.runtimeExecutionOwnerId,
    ) ||
    scope.kind !== "pglite" ||
    !boundedText(scope.realPath, 4096) ||
    !/^(?:\/|[A-Za-z]:[/\\]|\\\\)/.test(scope.realPath) ||
    typeof scope.device !== "string" ||
    !/^\d{1,30}$/.test(scope.device) ||
    typeof scope.inode !== "string" ||
    !/^\d{1,30}$/.test(scope.inode)
  )
    return null;
  return {
    agentId: owner.agentId,
    runtimeInstanceId: owner.runtimeInstanceId,
    runtimeExecutionOwnerId: owner.runtimeExecutionOwnerId,
    storageScope: {
      kind: "pglite",
      realPath: scope.realPath,
      device: scope.device,
      inode: scope.inode,
    },
  };
}

export function sameDevTrajectoryRecoveryScope(
  a: DevTrajectoryRecoveryOwner,
  b: DevTrajectoryRecoveryOwner,
): boolean {
  return (
    a.agentId === b.agentId &&
    a.runtimeInstanceId === b.runtimeInstanceId &&
    a.storageScope.kind === b.storageScope.kind &&
    a.storageScope.realPath === b.storageScope.realPath &&
    a.storageScope.device === b.storageScope.device &&
    a.storageScope.inode === b.storageScope.inode
  );
}

export function sameDevTrajectoryRecoveryOwner(
  a: DevTrajectoryRecoveryOwner,
  b: DevTrajectoryRecoveryOwner,
): boolean {
  return (
    sameDevTrajectoryRecoveryScope(a, b) &&
    a.runtimeExecutionOwnerId === b.runtimeExecutionOwnerId
  );
}

export function parseDevTrajectoryRecoveryChildMessage(
  value: unknown,
): DevTrajectoryRecoveryChildMessage | null {
  const message = record(value);
  if (
    message?.version !== DEV_TRAJECTORY_RECOVERY_VERSION ||
    !boundedText(message.requestId)
  )
    return null;
  const base = {
    version: DEV_TRAJECTORY_RECOVERY_VERSION,
    requestId: message.requestId,
  } as const;
  if (message.type === "eliza:trajectory-recovery:register") {
    const owner = parseDevTrajectoryRecoveryOwner(message.owner);
    return owner ? { ...base, type: message.type, owner } : null;
  }
  if (
    message.type === "eliza:trajectory-recovery:recovered" &&
    boundedText(message.recoveryBatchId)
  ) {
    return {
      ...base,
      type: message.type,
      recoveryBatchId: message.recoveryBatchId,
    };
  }
  return null;
}

export function parseDevTrajectoryRecoveryParentMessage(
  value: unknown,
): DevTrajectoryRecoveryParentMessage | null {
  const message = record(value);
  if (
    message?.version !== DEV_TRAJECTORY_RECOVERY_VERSION ||
    !boundedText(message.requestId)
  )
    return null;
  const base = {
    version: DEV_TRAJECTORY_RECOVERY_VERSION,
    requestId: message.requestId,
  } as const;
  if (
    message.type === "eliza:trajectory-recovery:rejected" &&
    boundedText(message.reason, 160)
  ) {
    return { ...base, type: message.type, reason: message.reason };
  }
  if (!boundedText(message.recoveryBatchId)) return null;
  if (message.type === "eliza:trajectory-recovery:acknowledged") {
    return {
      ...base,
      type: message.type,
      recoveryBatchId: message.recoveryBatchId,
    };
  }
  if (
    message.type !== "eliza:trajectory-recovery:registered" ||
    !Array.isArray(message.owners) ||
    message.owners.length > MAX_DEV_RECOVERY_OWNERS
  )
    return null;
  const owner = parseDevTrajectoryRecoveryOwner(message.owner);
  if (!owner) return null;
  const owners: DevTrajectoryRecoveryOwner[] = [];
  const tokens = new Set<string>();
  for (const value of message.owners) {
    const candidate = parseDevTrajectoryRecoveryOwner(value);
    if (!candidate || tokens.has(candidate.runtimeExecutionOwnerId))
      return null;
    tokens.add(candidate.runtimeExecutionOwnerId);
    owners.push(candidate);
  }
  return {
    ...base,
    type: message.type,
    owner,
    recoveryBatchId: message.recoveryBatchId,
    owners,
  };
}

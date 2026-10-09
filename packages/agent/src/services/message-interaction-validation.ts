/** Shared persistence validation for message-interaction store adapters. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIsoDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validBoundedJson(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 32 || ++nodes > 100_000) return false;
    if (typeof current.value === "string") {
      if (new TextEncoder().encode(current.value).length > 65_536) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 10_000) return false;
      for (const child of current.value)
        stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (isRecord(current.value)) {
      const entries = Object.entries(current.value);
      if (entries.length > 10_000) return false;
      for (const [key, child] of entries) {
        if (
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor" ||
          new TextEncoder().encode(key).length > 512
        )
          return false;
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function structurallyValidConsume(value: Record<string, unknown>): boolean {
  if (value.state === "pending") return true;
  if (
    value.state !== "claimed" &&
    value.state !== "committed" &&
    value.state !== "completed"
  )
    return false;
  if (
    typeof value.claimId !== "string" ||
    typeof value.replayKey !== "string" ||
    typeof value.responseDigest !== "string" ||
    !isRecord(value.response) ||
    !validIsoDate(value.claimedAt) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1
  )
    return false;
  if (value.state === "claimed")
    return (
      validIsoDate(value.claimExpiresAt) &&
      Date.parse(String(value.claimExpiresAt)) >
        Date.parse(String(value.claimedAt))
    );
  if (value.state === "committed")
    return (
      validIsoDate(value.committedAt) &&
      Date.parse(String(value.committedAt)) >=
        Date.parse(String(value.claimedAt))
    );
  const receipt = value.receipt;
  return (
    validIsoDate(value.committedAt) &&
    validIsoDate(value.completedAt) &&
    Date.parse(String(value.committedAt)) >=
      Date.parse(String(value.claimedAt)) &&
    Date.parse(String(value.completedAt)) >=
      Date.parse(String(value.committedAt)) &&
    isRecord(receipt) &&
    typeof receipt.receiptId === "string" &&
    receipt.idempotencyKey === value.replayKey &&
    receipt.status === "completed" &&
    validIsoDate(receipt.completedAt) &&
    isRecord(receipt.result)
  );
}

export function structurallyValidSession(
  value: unknown,
  reference: string,
): boolean {
  if (!isRecord(value)) return false;
  const bindings = value.bindings;
  const authorization = value.authorization;
  const consume = value.consume;
  return (
    value.sessionVersion === 1 &&
    value.reference === reference &&
    [
      "choice",
      "form",
      "approval",
      "setup",
      "auth",
      "task",
      "file",
      "followup",
    ].includes(String(value.purpose)) &&
    ["choice", "form", "followups", "task", "secret"].includes(
      String(value.blockKind),
    ) &&
    ["native", "conversational", "signed-hosted", "sensitive-request"].includes(
      String(value.flow),
    ) &&
    typeof value.profileId === "string" &&
    isRecord(bindings) &&
    typeof bindings.actorId === "string" &&
    isRecord(bindings.audience) &&
    typeof bindings.audience.kind === "string" &&
    typeof bindings.audience.id === "string" &&
    typeof bindings.agentId === "string" &&
    isRecord(bindings.connector) &&
    typeof bindings.connector.source === "string" &&
    typeof bindings.connector.accountId === "string" &&
    typeof bindings.roomId === "string" &&
    typeof bindings.sourceMessageId === "string" &&
    isRecord(value.responseSchema) &&
    Array.isArray(value.responseSchema.fields) &&
    value.responseSchema.additionalFields === false &&
    isRecord(authorization) &&
    typeof authorization.decisionId === "string" &&
    typeof authorization.policyRevision === "string" &&
    validIsoDate(authorization.decidedAt) &&
    ["active", "revoked"].includes(String(authorization.state)) &&
    ((authorization.state === "active" && authorization.revokedAt === null) ||
      (authorization.state === "revoked" &&
        validIsoDate(authorization.revokedAt))) &&
    isRecord(value.effect) &&
    typeof value.effect.kind === "string" &&
    validIsoDate(value.createdAt) &&
    validIsoDate(value.expiresAt) &&
    isRecord(consume) &&
    structurallyValidConsume(consume) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0
  );
}

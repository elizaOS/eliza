/** Binds definition creation previews and durable claims to one scoped operation. */
import { ElizaError } from "@elizaos/core";
import type { LifeOpsOwnership } from "../contracts/index.js";

export const DEFINITION_CREATION_OPERATION = "lifeops.definition.create";

export function definitionCreationIdentity(args: {
  agentId: string;
  actorId: string;
  ownership: Pick<LifeOpsOwnership, "domain" | "subjectType" | "subjectId">;
  key: string | undefined;
}): string | null {
  if (args.key === undefined) return null;
  if (
    typeof args.key !== "string" ||
    args.key.length === 0 ||
    args.key.length > 256 ||
    args.key.includes("\0")
  ) {
    throw new ElizaError(
      "[LifeOps] idempotencyKey must contain 1 to 256 non-NUL characters.",
      { code: "LIFEOPS_DEFINITION_IDEMPOTENCY_KEY_INVALID" },
    );
  }
  return JSON.stringify([
    DEFINITION_CREATION_OPERATION,
    args.agentId,
    args.actorId,
    args.ownership.domain,
    args.ownership.subjectType,
    args.ownership.subjectId,
    args.key,
  ]);
}

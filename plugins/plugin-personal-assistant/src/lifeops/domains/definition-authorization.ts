/**
 * Canonical definition scopes visible to the authenticated LifeOps caller.
 * Agent-owned operations and the configured owner's private operations are
 * the only valid domain/subject combinations in v1; persistence reads must
 * bind all three fields instead of loading agent-wide rows and filtering later.
 */
import type { LifeOpsContext } from "../lifeops-context.js";
import type { LifeOpsDefinitionScope } from "../repository.js";

export function callerDefinitionScopes(
  ctx: Pick<LifeOpsContext, "agentId" | "ownerEntityId">,
): readonly LifeOpsDefinitionScope[] {
  const agentId = ctx.agentId();
  return [
    { domain: "agent_ops", subjectType: "agent", subjectId: agentId },
    {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: ctx.ownerEntityId(),
    },
  ];
}

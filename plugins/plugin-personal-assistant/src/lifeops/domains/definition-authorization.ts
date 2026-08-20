/**
 * Canonical definition scopes visible to the authenticated LifeOps caller.
 * Agent-owned operations and the configured owner's private operations are
 * the only valid domain/subject combinations in v1; persistence reads must
 * bind all three fields instead of loading agent-wide rows and filtering later.
 */

import type {
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsTaskDefinition,
} from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import type {
  LifeOpsDefinitionScope,
  LifeOpsRepository,
} from "../repository.js";

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

export async function getCallerDefinition(
  repository: LifeOpsRepository,
  ctx: Pick<LifeOpsContext, "agentId" | "ownerEntityId">,
  definitionId: string,
): Promise<LifeOpsTaskDefinition | null> {
  for (const scope of callerDefinitionScopes(ctx)) {
    const definition = await repository.getDefinition(
      ctx.agentId(),
      definitionId,
      scope,
    );
    if (definition) return definition;
  }
  return null;
}

export async function getCallerOccurrence(
  repository: LifeOpsRepository,
  ctx: Pick<LifeOpsContext, "agentId" | "ownerEntityId">,
  occurrenceId: string,
): Promise<LifeOpsOccurrence | null> {
  for (const scope of callerDefinitionScopes(ctx)) {
    const occurrence = await repository.getOccurrence(
      ctx.agentId(),
      occurrenceId,
      scope,
    );
    if (occurrence) return occurrence;
  }
  return null;
}

export async function getCallerOccurrenceView(
  repository: LifeOpsRepository,
  ctx: Pick<LifeOpsContext, "agentId" | "ownerEntityId">,
  occurrenceId: string,
): Promise<LifeOpsOccurrenceView | null> {
  for (const scope of callerDefinitionScopes(ctx)) {
    const occurrence = await repository.getOccurrenceView(
      ctx.agentId(),
      occurrenceId,
      scope,
    );
    if (occurrence) return occurrence;
  }
  return null;
}

export async function listCallerDefinitions(
  repository: LifeOpsRepository,
  ctx: Pick<LifeOpsContext, "agentId" | "ownerEntityId">,
  options: { activeOnly?: boolean } = {},
): Promise<LifeOpsTaskDefinition[]> {
  const method = options.activeOnly
    ? "listActiveDefinitions"
    : "listDefinitions";
  return (
    await Promise.all(
      callerDefinitionScopes(ctx).map((scope) =>
        repository[method](ctx.agentId(), scope),
      ),
    )
  )
    .flat()
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

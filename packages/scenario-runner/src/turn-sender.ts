/**
 * Resolves authenticated scenario-turn authors into stable principals and the
 * trusted metadata that real connector ingress supplies to the runtime.
 */

import { stringToUuid, type UUID } from "@elizaos/core";
import type { ScenarioTurn } from "@elizaos/scenario-runner/schema";

type ScenarioTurnSender = NonNullable<ScenarioTurn["sender"]>;

export function resolveScenarioTurnSender(input: {
  scenarioId: string;
  source: string;
  defaultEntityId: UUID;
  sender?: ScenarioTurnSender;
}): {
  entityId: UUID;
  metadata: Record<string, unknown>;
} {
  const { scenarioId, source, defaultEntityId, sender } = input;
  if (!sender) {
    return { entityId: defaultEntityId, metadata: {} };
  }

  return {
    entityId: stringToUuid(
      `scenario-turn-sender:${scenarioId}:${source}:${sender.id}`,
    ) as UUID,
    metadata: {
      entityName: sender.name,
      sender: { id: sender.id, name: sender.name },
      fromBot: sender.kind === "bot",
    },
  };
}

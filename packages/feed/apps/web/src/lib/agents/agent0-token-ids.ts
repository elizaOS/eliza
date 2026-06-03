import { agentRegistries, db, inArray } from "@feed/db";

export function parseAgent0TokenId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export async function getAgent0TokenIdsByAgentId(
  agentIds: string[],
): Promise<Map<string, number | null>> {
  const uniqueAgentIds = [...new Set(agentIds)].filter(Boolean);
  if (uniqueAgentIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      agentId: agentRegistries.agentId,
      agent0TokenId: agentRegistries.agent0TokenId,
    })
    .from(agentRegistries)
    .where(inArray(agentRegistries.agentId, uniqueAgentIds));

  return new Map(
    rows.map((row) => [
      row.agentId,
      parseAgent0TokenId(row.agent0TokenId ?? null),
    ]),
  );
}

export async function getAgent0TokenIdByAgentId(
  agentId: string,
): Promise<number | null> {
  const tokenIds = await getAgent0TokenIdsByAgentId([agentId]);
  return tokenIds.get(agentId) ?? null;
}

/**
 * Resolves a route-supplied agent identifier to the canonical character/runtime
 * agent ID within the caller's organization. Product surfaces may address an
 * agent by its sandbox ID for compatibility, but bindings and OAuth state must
 * persist only the canonical character ID. Returns null when neither a direct
 * character nor a sandbox-backed character exists in that organization.
 */
import { userCharactersRepository } from "../../db/repositories/characters";
import { elizaSandboxService } from "./eliza-sandbox";

export async function resolveCanonicalAgentId(
  routeAgentId: string,
  organizationId: string,
): Promise<string | null> {
  const direct = await userCharactersRepository.findByIdInOrganization(
    routeAgentId,
    organizationId,
  );
  if (direct) return direct.id;
  const sandbox = await elizaSandboxService.getAgent(routeAgentId, organizationId);
  if (!sandbox?.character_id) return null;
  const character = await userCharactersRepository.findByIdInOrganization(
    sandbox.character_id,
    organizationId,
  );
  return character?.id ?? null;
}

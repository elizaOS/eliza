/**
 * Credentials a member brought into an organization leave with the member.
 *
 * A removed member (or one who leaves by accepting another organization's
 * invite) keeps no live credential in the old organization: provider keys they
 * contributed to the team pool are removed (the pool would keep billing their
 * provider account), and connections they linked themselves (for example a
 * personal LinkedIn) are revoked (the organization could keep posting as them,
 * and after they leave nobody in Cloud can see or remove the connection). An
 * organization agent they bound to their own Discord guild is unbound (the
 * gateway routes that guild's messages by the linking member's Discord id, so
 * they could keep driving the agent on the organization's credits).
 */

import { and, eq } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { pooledCredentialsRepository } from "../../db/repositories/pooled-credentials";
import { platformCredentials } from "../../db/schemas/platform-credentials";
import { managedAgentDiscordService } from "./agent-managed-discord";
import { discordAutomationService } from "./discord-automation";
import { readManagedAgentDiscordBinding } from "./eliza-agent-config";
import { oauthService } from "./oauth";
import { removePooledCredential } from "./team-credential-pool/service";

export async function releaseDepartedMemberCredentials(
  userId: string,
  organizationId: string,
): Promise<void> {
  const contributed = (await pooledCredentialsRepository.listByOrganization(organizationId)).filter(
    (row) => row.contributed_by === userId,
  );
  for (const row of contributed) {
    await removePooledCredential({
      credentialId: row.id,
      organizationId,
      audit: {
        actorType: "system",
        actorId: userId,
        source: "member_departure",
      },
    });
  }

  const linked = await dbWrite
    .select({ id: platformCredentials.id })
    .from(platformCredentials)
    .where(
      and(
        eq(platformCredentials.organization_id, organizationId),
        eq(platformCredentials.user_id, userId),
        eq(platformCredentials.status, "active"),
      ),
    );
  for (const connection of linked) {
    await oauthService.revokeConnection({ organizationId, connectionId: connection.id });
  }

  for (const sandbox of await agentSandboxesRepository.listByOrganization(organizationId)) {
    const binding = readManagedAgentDiscordBinding(
      sandbox.agent_config as Record<string, unknown> | null,
    );
    if (binding?.adminElizaUserId !== userId) continue;
    await managedAgentDiscordService.disconnectAgent({
      agentId: sandbox.id,
      organizationId,
      configured: discordAutomationService.isOAuthConfigured(),
      applicationId: discordAutomationService.getApplicationId(),
    });
  }
}

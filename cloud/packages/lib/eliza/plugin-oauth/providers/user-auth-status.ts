/**
 * USER_AUTH_STATUS Provider - Injects user auth status into agent context.
 */

import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { usersRepository } from "@/db/repositories/users";
import { oauthService } from "@/lib/services/oauth";
import { capitalize, formatConnectionIdentifier } from "../utils";

export const userAuthStatusProvider: Provider = {
  name: "USER_AUTH_STATUS",
  description: "Provides user OAuth connection status and credits balance",
  contexts: ["connectors", "settings"],
  contextGate: { anyOf: ["connectors", "settings"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    if (!message.entityId) {
      return { text: "", values: {}, data: {} };
    }
    try {
      const user = await usersRepository.findWithOrganization(message.entityId as string);

    if (!user || !user.organization_id) {
      logger.debug(`[USER_AUTH_STATUS] No user/org for entityId: ${message.entityId}`);
      return {
        text: "# User Status\n- Status: Unknown user",
        values: { userAuthenticated: false, hasOrganization: false },
        data: { userAuthStatus: { authenticated: false, connections: [] } },
      };
    }

    const { organization_id: organizationId, id: userId } = user;
    const connections = await oauthService.listConnections({
      organizationId,
      userId,
    });
    const active = connections.filter((c) => c.status === "active");

    const creditBalance = user.organization?.credit_balance
      ? parseFloat(user.organization.credit_balance)
      : 0;

    const googleConnection = active.find((c) => c.platform === "google");
    const connectionsList =
      active.length > 0
        ? active
            .map((c) => {
              const id = formatConnectionIdentifier(c);
              return id ? `${capitalize(c.platform)} (${id})` : capitalize(c.platform);
            })
            .join(", ")
        : "None";

    const status =
      active.length === 0
        ? "Not authenticated - needs to connect Google"
        : creditBalance <= 0
          ? "Authenticated but no credits"
          : "Fully authenticated";

    const text = `# User Authentication Status
- Connections: ${connectionsList}
- Credits: ${creditBalance.toFixed(2)}
- Status: ${status}`;

    logger.debug(
      `[USER_AUTH_STATUS] User ${userId}: ${active.length} connections, ${creditBalance} credits`,
    );

      return {
        text,
        values: {
          userAuthenticated: active.length > 0,
          hasGoogleConnected: !!googleConnection,
          googleEmail: googleConnection?.email || null,
          creditBalance,
          hasCredits: creditBalance > 0,
          connectionCount: active.length,
          connectedPlatforms: active.map((c) => c.platform),
          authStatus: status,
        },
        data: {
          userAuthStatus: {
            authenticated: active.length > 0,
            userId,
            organizationId,
            creditBalance,
            connections: active.slice(0, 20).map((c) => ({
              platform: c.platform,
              email: c.email,
              username: c.username,
              status: c.status,
            })),
          },
        },
      };
    } catch (error) {
      logger.warn(
        `[USER_AUTH_STATUS] Provider fallback for entityId ${message.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        text: "# User Status\n- Status: unavailable",
        values: { userAuthenticated: false, hasOrganization: false },
        data: {
          userAuthStatus: {
            authenticated: false,
            connections: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  },
};

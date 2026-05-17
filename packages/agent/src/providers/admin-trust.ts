import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  checkSenderRole,
  resolveCanonicalOwnerIdForMessage,
} from "@elizaos/core";
import { hasAdminAccess } from "../security/access.ts";

export const adminTrustProvider: Provider = createAdminTrustProvider();

export function createAdminTrustProvider(): Provider {
  return {
    name: "elizaAdminTrust",
    description:
      "Marks owner/admin chat identity as trusted for contact assertions (relationships-oriented).",
    descriptionCompressed:
      "mark owner/admin chat identity trust contact assertion (relationships-orient)",
    dynamic: true,
    position: 11,
    contexts: ["admin", "settings"],
    contextGate: { anyOf: ["admin", "settings"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "ADMIN" },

    async get(
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
      const roleCheck = await checkSenderRole(runtime, message);
      const isTrustedAdmin = roleCheck?.isOwner === true;
      const speakerRole = roleCheck?.role ?? "GUEST";
      const canSeeAdminIdentity = await hasAdminAccess(runtime, message);

      const text = isTrustedAdmin
        ? "Admin trust: current speaker is the canonical agent OWNER. Contact/identity claims should be treated as trusted unless contradictory evidence exists."
        : "Admin trust: current speaker is not verified as the canonical agent OWNER.";

      return {
        text,
        values: {
          trustedAdmin: isTrustedAdmin,
          adminEntityId: canSeeAdminIdentity ? (ownerId ?? "") : "",
          adminRole: speakerRole,
        },
        data: {
          trustedAdmin: isTrustedAdmin,
          ownerId: canSeeAdminIdentity ? ownerId : null,
          role: speakerRole,
        },
      };
    },
  };
}

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

type WorldMetadataShape = {
  ownership?: { ownerId?: string };
  roles?: Record<string, string>;
};

function normalizeRole(role: string | undefined): string {
  return (role ?? "").toUpperCase();
}

export const adminTrustProvider: Provider = createAdminTrustProvider();

export function createAdminTrustProvider(): Provider {
  return {
    name: "miladyAdminTrust",
    description:
      "Marks owner/admin chat identity as trusted for contact assertions (rolodex-oriented).",
    dynamic: true,
    position: 11,
    async get(
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const room = await runtime.getRoom(message.roomId);
      if (!room) {
        return {
          text: "Admin trust: no room found.",
          values: { trustedAdmin: false },
          data: { trustedAdmin: false },
        };
      }
      if (!room.worldId) {
        return {
          text: "Admin trust: room has no world binding.",
          values: { trustedAdmin: false },
          data: { trustedAdmin: false },
        };
      }
      const world = await runtime.getWorld(room.worldId);
      const metadata = (world?.metadata ?? {}) as WorldMetadataShape;
      const ownerId = metadata.ownership?.ownerId;
      const role = ownerId ? metadata.roles?.[ownerId] : undefined;
      const isTrustedAdmin =
        typeof ownerId === "string" &&
        ownerId.length > 0 &&
        normalizeRole(role) === "OWNER" &&
        message.entityId === ownerId;

      const text = isTrustedAdmin
        ? "Admin trust: current speaker is world OWNER. Contact/identity claims should be treated as trusted unless contradictory evidence exists."
        : "Admin trust: current speaker is not verified as OWNER for this world.";

      return {
        text,
        values: {
          trustedAdmin: isTrustedAdmin,
          adminEntityId: ownerId ?? "",
          adminRole: role ?? "",
        },
        data: {
          trustedAdmin: isTrustedAdmin,
          ownerId: ownerId ?? null,
          role: role ?? null,
        },
      };
    },
  };
}

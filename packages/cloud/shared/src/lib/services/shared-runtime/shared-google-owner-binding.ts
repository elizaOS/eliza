/** Server-owned binding; no RPC field can grant private-data/model-context consent. */
import { ChannelType } from "@elizaos/core";
import { readPersonalGoogleContextOwner } from "../../../db/repositories/personal-google-context-consent";
import { isCanonicalPersonalSharedAgent } from "./personal-shared-identity";
import { selectedGoogleContextConsent } from "./shared-google-consent";
import { createSharedGoogleReadPort } from "./shared-google-read-port";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import { normalizeSharedRuntimeRoom } from "./shared-runtime-room-identity";

/** The canonical private journal is server-derived; a DM label alone is insufficient. */
export function isPersonalGooglePrivateAudience(
  agent: SharedRuntimeAgent,
  channel: { type: ChannelType },
  room: { roomId?: unknown; userId?: unknown },
): boolean {
  return (
    isCanonicalPersonalSharedAgent(agent) &&
    channel.type === ChannelType.DM &&
    normalizeSharedRuntimeRoom(room.roomId, room.userId) === agent.id
  );
}

export async function createOwnerBoundSharedGooglePort(
  agent: SharedRuntimeAgent,
  channel: { type: ChannelType },
  room: { roomId?: unknown; userId?: unknown },
  loadOwner = (id: string) =>
    readPersonalGoogleContextOwner({
      userId: id,
      organizationId: agent.organization_id,
    }),
  bindPort: typeof createSharedGoogleReadPort = createSharedGoogleReadPort,
) {
  if (!isPersonalGooglePrivateAudience(agent, channel, room)) {
    throw new Error("SHARED_GOOGLE_PRIVATE_PERSONAL_ROOM_REQUIRED");
  }
  // Only explicit Google action dispatch calls this, not ordinary chat or prewarm.
  const owner = await loadOwner(agent.user_id);
  if (
    !owner ||
    owner.id !== agent.user_id ||
    owner.organization_id !== agent.organization_id ||
    !owner.is_active ||
    owner.deleted_at
  )
    throw new Error("SHARED_GOOGLE_OWNER_CHANGED");
  const consent = selectedGoogleContextConsent(owner.preferences);
  return bindPort({
    organizationId: agent.organization_id,
    userId: agent.user_id,
    grantId: consent?.grantId,
    authorizePrivateRead: async (request) => {
      // Selection and lifecycle can change after binding or between reads.
      // Reobserve primary owner metadata; the token cache is never consent authority.
      const current = await loadOwner(agent.user_id);
      const currentConsent =
        current?.id === agent.user_id &&
        current.organization_id === agent.organization_id &&
        current.is_active &&
        !current.deleted_at
          ? selectedGoogleContextConsent(current.preferences)
          : undefined;
      const feature = request.kind === "calendar" ? "calendar.read" : "gmail.read";
      if (
        !consent ||
        !currentConsent ||
        currentConsent.grantId !== consent.grantId ||
        !currentConsent.features.includes(feature)
      ) {
        throw new Error("SHARED_GOOGLE_PERSONAL_CONTEXT_CONSENT_REQUIRED");
      }
    },
  });
}

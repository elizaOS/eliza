/**
 * DB-backed entry point for the connected-capability projection service: the
 * Drizzle source loader (each table read filtered by organization ID at the
 * SQL layer) and the process-wide singleton the Cloud API routes import.
 *
 * Each `.select()` below names an explicit column list — never a bare
 * `.select()` — so a token, ciphertext, DEK, or nonce column can never enter
 * Worker memory in the first place; `projection.ts`'s row types are the
 * contract this loader must keep matching (#19883 follow-up). Vendor
 * connections need to know only whether a refresh token exists, computed in
 * SQL (`col IS NOT NULL`) rather than by reading the encrypted value.
 *
 * Every query also carries a hard `.limit()` ordered by `(created_at, id)`,
 * so a request's cost — row fan-out, per-row account-id hashing, and the
 * final cross-source sort in `service.ts` — is bounded by a constant
 * independent of how many rows the organization has accumulated in any one
 * source table, not by the requested page size.
 */

import { asc, eq, sql } from "drizzle-orm";
import { dbRead } from "../../../db/client";
import { discordConnections } from "../../../db/schemas/discord-connections";
import { phoneGatewayDevices } from "../../../db/schemas/phone-gateway-devices";
import { platformCredentials } from "../../../db/schemas/platform-credentials";
import { vendorConnections } from "../../../db/schemas/vendor-connections";
import { ConnectedCapabilitiesService, type ConnectedCapabilitySourceLoader } from "./service";

export * from "./service";

/**
 * Per-table row cap for one connected-capability read. Chosen well above any
 * real organization's connection count while still bounding worst-case cost
 * to a fixed constant; raise it only alongside deliberate pagination-depth
 * design, not as a quick unblock.
 */
export const MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE = 1000;

function createDbSourceLoader(): ConnectedCapabilitySourceLoader {
  return {
    async load(organizationId) {
      const [platform, vendor, discord, phone] = await Promise.all([
        dbRead
          .select({
            id: platformCredentials.id,
            platform: platformCredentials.platform,
            platform_display_name: platformCredentials.platform_display_name,
            platform_username: platformCredentials.platform_username,
            status: platformCredentials.status,
            scopes: platformCredentials.scopes,
            last_used_at: platformCredentials.last_used_at,
            deleted_at: platformCredentials.deleted_at,
          })
          .from(platformCredentials)
          .where(eq(platformCredentials.organization_id, organizationId))
          .orderBy(asc(platformCredentials.created_at), asc(platformCredentials.id))
          .limit(MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE),
        dbRead
          .select({
            id: vendorConnections.id,
            vendor: vendorConnections.vendor,
            label: vendorConnections.label,
            expires_at: vendorConnections.expires_at,
            scopes: vendorConnections.scopes,
            deleted_at: vendorConnections.deleted_at,
            hasRefreshToken: sql<boolean>`${vendorConnections.refresh_token_encrypted} is not null`,
          })
          .from(vendorConnections)
          .where(eq(vendorConnections.organization_id, organizationId))
          .orderBy(asc(vendorConnections.created_at), asc(vendorConnections.id))
          .limit(MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE),
        dbRead
          .select({
            id: discordConnections.id,
            is_active: discordConnections.is_active,
            status: discordConnections.status,
            last_heartbeat: discordConnections.last_heartbeat,
          })
          .from(discordConnections)
          .where(eq(discordConnections.organization_id, organizationId))
          .orderBy(asc(discordConnections.created_at), asc(discordConnections.id))
          .limit(MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE),
        dbRead
          .select({
            id: phoneGatewayDevices.id,
            isRetiredBlueBubbles: sql<boolean>`
              lower(btrim(coalesce(${phoneGatewayDevices.send_method}, ''))) = 'bluebubbles-local-bridge'
              or lower(btrim(coalesce(${phoneGatewayDevices.metadata} ->> 'gatewayKind', ''))) = 'bluebubbles'
            `,
            is_active: phoneGatewayDevices.is_active,
            can_send_sms: phoneGatewayDevices.can_send_sms,
            can_receive_sms: phoneGatewayDevices.can_receive_sms,
            can_send_imessage: phoneGatewayDevices.can_send_imessage,
            can_receive_imessage: phoneGatewayDevices.can_receive_imessage,
            friendly_name: phoneGatewayDevices.friendly_name,
            phone_account_label: phoneGatewayDevices.phone_account_label,
            last_seen_at: phoneGatewayDevices.last_seen_at,
          })
          .from(phoneGatewayDevices)
          .where(eq(phoneGatewayDevices.organization_id, organizationId))
          .orderBy(asc(phoneGatewayDevices.created_at), asc(phoneGatewayDevices.id))
          .limit(MAX_ROWS_PER_CONNECTED_CAPABILITY_SOURCE),
      ]);
      return {
        platformCredentials: platform,
        vendorConnections: vendor,
        discordConnections: discord,
        phoneGatewayDevices: phone,
      };
    },
  };
}

export const connectedCapabilitiesService = new ConnectedCapabilitiesService(
  createDbSourceLoader(),
);

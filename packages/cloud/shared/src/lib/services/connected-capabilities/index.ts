/**
 * DB-backed entry point for the connected-capability projection service: the
 * Drizzle source loader (each table read filtered by organization ID at the
 * SQL layer) and the process-wide singleton the Cloud API routes import.
 */

import { eq } from "drizzle-orm";
import { dbRead } from "../../../db/client";
import { discordConnections } from "../../../db/schemas/discord-connections";
import { phoneGatewayDevices } from "../../../db/schemas/phone-gateway-devices";
import { platformCredentials } from "../../../db/schemas/platform-credentials";
import { vendorConnections } from "../../../db/schemas/vendor-connections";
import { ConnectedCapabilitiesService, type ConnectedCapabilitySourceLoader } from "./service";

export * from "./service";

function createDbSourceLoader(): ConnectedCapabilitySourceLoader {
  return {
    async load(organizationId) {
      const [platform, vendor, discord, phone] = await Promise.all([
        dbRead
          .select()
          .from(platformCredentials)
          .where(eq(platformCredentials.organization_id, organizationId)),
        dbRead
          .select()
          .from(vendorConnections)
          .where(eq(vendorConnections.organization_id, organizationId)),
        dbRead
          .select()
          .from(discordConnections)
          .where(eq(discordConnections.organization_id, organizationId)),
        dbRead
          .select()
          .from(phoneGatewayDevices)
          .where(eq(phoneGatewayDevices.organization_id, organizationId)),
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

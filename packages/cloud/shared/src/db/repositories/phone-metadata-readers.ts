/** Canonical lossless read boundaries for phone JSONB metadata columns. */

import { getTableColumns, sql } from "drizzle-orm";
import { parsePhoneLosslessJsonObject } from "../../lib/services/phone-lossless-json";
import {
  PHONE_GATEWAY_METADATA_INVALID,
  PHONE_STORED_JSON_INVALID,
  requirePhoneJsonObject,
} from "../../lib/services/phone-payload-validation";
import { type AgentPhoneContact, agentPhoneContacts } from "../schemas/agent-phone-contacts";
import { type AgentPhoneNumber, agentPhoneNumbers } from "../schemas/agent-phone-numbers";
import { type PhoneGatewayDevice, phoneGatewayDevices } from "../schemas/phone-gateway-devices";

/**
 * These expressions, rather than the JSONB columns themselves, are the only
 * values a request-runtime metadata reader may pass through the SQL driver.
 */
export const agentPhoneNumberMetadataText = sql<string | null>`${agentPhoneNumbers.metadata}::text`;
export const agentPhoneContactMetadataText = sql<string>`${agentPhoneContacts.metadata}::text`;
export const phoneGatewayDeviceMetadataText = sql<string>`${phoneGatewayDevices.metadata}::text`;

export const agentPhoneNumberLosslessSelection = {
  ...getTableColumns(agentPhoneNumbers),
  metadata: agentPhoneNumberMetadataText,
};

export const agentPhoneContactLosslessSelection = {
  ...getTableColumns(agentPhoneContacts),
  metadata: agentPhoneContactMetadataText,
};

export const phoneGatewayDeviceLosslessSelection = {
  ...getTableColumns(phoneGatewayDevices),
  metadata: phoneGatewayDeviceMetadataText,
};

function parseRequiredMetadata(
  raw: string | null,
  field: string,
  code: string,
): Record<string, unknown> {
  if (raw === null) {
    throw new TypeError("Required persisted phone metadata is null");
  }
  return requirePhoneJsonObject(parsePhoneLosslessJsonObject(raw), { field, code });
}

export function parseAgentPhoneNumberMetadata(raw: string | null): Record<string, unknown> | null {
  return raw === null
    ? null
    : requirePhoneJsonObject(parsePhoneLosslessJsonObject(raw), {
        field: "agent_phone_numbers.metadata",
        code: PHONE_STORED_JSON_INVALID,
      });
}

export function parseAgentPhoneContactMetadata(raw: string | null): Record<string, unknown> {
  return parseRequiredMetadata(raw, "agent_phone_contacts.metadata", PHONE_STORED_JSON_INVALID);
}

export function parsePhoneGatewayDeviceMetadata(raw: string | null): Record<string, unknown> {
  return parseRequiredMetadata(
    raw,
    "phone_gateway_devices.metadata",
    PHONE_GATEWAY_METADATA_INVALID,
  );
}

type AgentPhoneNumberTextRow = Omit<AgentPhoneNumber, "metadata"> & {
  metadata: string | null;
};

type AgentPhoneContactTextRow = Omit<AgentPhoneContact, "metadata"> & {
  metadata: string;
};

type PhoneGatewayDeviceTextRow = Omit<PhoneGatewayDevice, "metadata"> & {
  metadata: string;
};

export function hydrateAgentPhoneNumber(row: AgentPhoneNumberTextRow): AgentPhoneNumber {
  return { ...row, metadata: parseAgentPhoneNumberMetadata(row.metadata) };
}

export function hydrateAgentPhoneContact(row: AgentPhoneContactTextRow): AgentPhoneContact {
  return { ...row, metadata: parseAgentPhoneContactMetadata(row.metadata) };
}

export function hydratePhoneGatewayDevice(row: PhoneGatewayDeviceTextRow): PhoneGatewayDevice {
  return { ...row, metadata: parsePhoneGatewayDeviceMetadata(row.metadata) };
}

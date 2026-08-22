/** Coordinates cloud phone-gateway registration, authentication, and presence state. */
import { ElizaError } from "@elizaos/core";
import { type Database, type DbTransaction, dbWrite } from "../../db/client";
import { phoneGatewayDevices } from "../../db/schemas/phone-gateway-devices";
import { logger } from "../utils/logger";
import { normalizePhoneNumber } from "../utils/phone-normalization";
import { isPostgresUndefinedTableError, phoneErrorDiagnostic } from "./phone-error-diagnostics";
import { PHONE_GATEWAY_METADATA_INVALID, requirePhoneJsonObject } from "./phone-payload-validation";

export type PhoneGatewayProvider = "twilio" | "blooio" | "vonage" | "whatsapp" | "other";

export interface RegisterPhoneGatewayDeviceInput {
  organizationId?: string | null;
  provider: PhoneGatewayProvider;
  phoneNumber: string;
  bridgeId?: string | null;
  phoneAccountId?: string | null;
  phoneAccountLabel?: string | null;
  friendlyName?: string | null;
  sendMethod?: string | null;
  cloudWebhookUrl?: string | null;
  localWebhookUrl?: string | null;
  metadata?: Record<string, unknown>;
  markSeen?: boolean;
}

export interface RegisterPhoneGatewayDeviceResult {
  id: string | null;
  registered: boolean;
  skippedReason?: "missing_phone_number" | "table_missing" | "write_failed";
}

function providerDiagnostic(value: unknown): string {
  return value === "twilio" ||
    value === "blooio" ||
    value === "vonage" ||
    value === "whatsapp" ||
    value === "other"
    ? value
    : "unknown";
}

function isUndefinedTableError(error: unknown): boolean {
  return isPostgresUndefinedTableError(error);
}

function schemaMigrationRequired(error: unknown): ElizaError {
  return new ElizaError("Phone gateway schema migration is required", {
    code: "PHONE_SCHEMA_MIGRATION_REQUIRED",
    context: { table: "phone_gateway_devices" },
    cause: error,
  });
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function registerPhoneGatewayDevice(
  input: RegisterPhoneGatewayDeviceInput,
): Promise<RegisterPhoneGatewayDeviceResult> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    return { id: null, registered: false, skippedReason: "missing_phone_number" };
  }

  const upsert = async () => await upsertPhoneGatewayDevice(input, dbWrite);

  try {
    return await upsert();
  } catch (error) {
    // error-policy:J4 generic legacy persistence failures become the explicit
    // write_failed result; typed validation and missing-schema failures rethrow.
    if (error instanceof ElizaError && error.code === PHONE_GATEWAY_METADATA_INVALID) {
      throw error;
    }
    if (isUndefinedTableError(error)) {
      // error-policy:J2 request-serving code must not synthesize a divergent table.
      throw schemaMigrationRequired(error);
    }
    logger.warn("[phone-gateway-devices] failed to register gateway device", {
      provider: providerDiagnostic(input.provider),
      ...phoneErrorDiagnostic(error),
    });
    return { id: null, registered: false, skippedReason: "write_failed" };
  }
}

async function upsertPhoneGatewayDevice(
  input: RegisterPhoneGatewayDeviceInput,
  writer: Database | DbTransaction,
): Promise<RegisterPhoneGatewayDeviceResult> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    return { id: null, registered: false, skippedReason: "missing_phone_number" };
  }
  const now = new Date();
  const lastSeenAt = input.markSeen === false ? null : now;
  const bridgeId = nullableText(input.bridgeId) ?? "default";
  const metadata = requirePhoneJsonObject(input.metadata ?? {}, {
    field: "phone_gateway_devices.metadata",
    code: PHONE_GATEWAY_METADATA_INVALID,
  });
  const [record] = await writer
    .insert(phoneGatewayDevices)
    .values({
      organization_id: nullableText(input.organizationId),
      provider: input.provider,
      phone_number: phoneNumber,
      bridge_id: bridgeId,
      phone_account_id: nullableText(input.phoneAccountId),
      phone_account_label: nullableText(input.phoneAccountLabel),
      friendly_name: nullableText(input.friendlyName),
      send_method: nullableText(input.sendMethod),
      cloud_webhook_url: nullableText(input.cloudWebhookUrl),
      local_webhook_url: nullableText(input.localWebhookUrl),
      metadata,
      is_active: true,
      last_seen_at: lastSeenAt,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        phoneGatewayDevices.provider,
        phoneGatewayDevices.phone_number,
        phoneGatewayDevices.bridge_id,
      ],
      set: {
        organization_id: nullableText(input.organizationId),
        phone_account_id: nullableText(input.phoneAccountId),
        phone_account_label: nullableText(input.phoneAccountLabel),
        friendly_name: nullableText(input.friendlyName),
        send_method: nullableText(input.sendMethod),
        cloud_webhook_url: nullableText(input.cloudWebhookUrl),
        local_webhook_url: nullableText(input.localWebhookUrl),
        metadata,
        is_active: true,
        last_seen_at: lastSeenAt,
        updated_at: now,
      },
    })
    .returning({ id: phoneGatewayDevices.id });

  return { id: record?.id ?? null, registered: true };
}

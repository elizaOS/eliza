// Coordinates cloud service phone gateway devices behavior behind route handlers.
import { sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { phoneGatewayDevices } from "../../db/schemas/phone-gateway-devices";
import { logger } from "../utils/logger";
import { normalizePhoneNumber } from "../utils/phone-normalization";

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
}

export interface RegisterPhoneGatewayDeviceResult {
  id: string | null;
  registered: boolean;
  skippedReason?: "missing_phone_number" | "table_missing" | "write_failed";
}

let ensureTablePromise: Promise<void> | null = null;

function isUndefinedTableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: unknown }).code === "42P01") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isUndefinedTableError(cause);
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    message.includes('relation "phone_gateway_devices" does not exist')
  );
}

async function ensurePhoneGatewayDevicesTable(): Promise<void> {
  ensureTablePromise ??= (async () => {
    await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS phone_gateway_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID,
        provider phone_provider NOT NULL,
        phone_number TEXT NOT NULL,
        bridge_id TEXT NOT NULL DEFAULT 'default',
        phone_account_id TEXT,
        phone_account_label TEXT,
        friendly_name TEXT,
        send_method TEXT,
        cloud_webhook_url TEXT,
        local_webhook_url TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        can_send_sms BOOLEAN NOT NULL DEFAULT true,
        can_receive_sms BOOLEAN NOT NULL DEFAULT true,
        can_send_imessage BOOLEAN NOT NULL DEFAULT true,
        can_receive_imessage BOOLEAN NOT NULL DEFAULT true,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMP
      )
    `);
    await dbWrite.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS phone_gateway_devices_provider_phone_bridge_idx
      ON phone_gateway_devices(provider, phone_number, bridge_id)
    `);
    await dbWrite.execute(sql`
      CREATE INDEX IF NOT EXISTS phone_gateway_devices_organization_idx
      ON phone_gateway_devices(organization_id)
    `);
    await dbWrite.execute(sql`
      CREATE INDEX IF NOT EXISTS phone_gateway_devices_phone_number_idx
      ON phone_gateway_devices(phone_number)
    `);
    await dbWrite.execute(sql`
      CREATE INDEX IF NOT EXISTS phone_gateway_devices_is_active_idx
      ON phone_gateway_devices(is_active)
    `);
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
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

  const now = new Date();
  const bridgeId = nullableText(input.bridgeId) ?? "default";
  const metadata = JSON.stringify(input.metadata ?? {});

  const upsert = async () => {
    const [record] = await dbWrite
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
        last_seen_at: now,
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
          last_seen_at: now,
          updated_at: now,
        },
      })
      .returning({ id: phoneGatewayDevices.id });

    return { id: record?.id ?? null, registered: true };
  };

  try {
    return await upsert();
  } catch (error) {
    if (isUndefinedTableError(error)) {
      try {
        await ensurePhoneGatewayDevicesTable();
        return await upsert();
      } catch (ensureError) {
        logger.warn("[phone-gateway-devices] table is not migrated yet", {
          error: ensureError instanceof Error ? ensureError.message : String(ensureError),
        });
        return { id: null, registered: false, skippedReason: "table_missing" };
      }
    }
    logger.warn("[phone-gateway-devices] failed to register gateway device", {
      provider: input.provider,
      phoneNumber,
      bridgeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { id: null, registered: false, skippedReason: "write_failed" };
  }
}

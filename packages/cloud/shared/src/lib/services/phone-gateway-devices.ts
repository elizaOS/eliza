/** Coordinates cloud phone-gateway registration, authentication, and presence state. */
import { and, eq, sql } from "drizzle-orm";
import { type Database, type DbTransaction, dbRead, dbWrite } from "../../db/client";
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
  markSeen?: boolean;
}

export interface RegisterPhoneGatewayDeviceResult {
  id: string | null;
  registered: boolean;
  skippedReason?: "missing_phone_number" | "table_missing" | "write_failed";
}

interface LegacyBlueBubblesGatewayMetadata extends Record<string, unknown> {
  schemaVersion: 1;
  gatewayKind: "bluebubbles";
  ownerUserId: string;
  agentId: string;
  authTokenHash: string;
  tokenCreatedAt: string;
}

export type BlueBubblesGatewayRoutingMode = "sender-owned" | "fixed-agent";

interface BlueBubblesGatewayMetadataV2 extends Record<string, unknown> {
  schemaVersion: 2;
  gatewayKind: "bluebubbles";
  ownerUserId: string;
  routingMode: BlueBubblesGatewayRoutingMode;
  agentId: string | null;
  authTokenHash: string;
  tokenCreatedAt: string;
}

type BlueBubblesGatewayMetadata = LegacyBlueBubblesGatewayMetadata | BlueBubblesGatewayMetadataV2;

export interface BlueBubblesGatewayRegistration {
  id: string;
  bridgeId: string;
  token: string;
  phoneNumber: string;
  organizationId: string;
  userId: string;
  routingMode: BlueBubblesGatewayRoutingMode;
  agentId: string | null;
}

export interface AuthenticatedBlueBubblesGateway {
  id: string;
  bridgeId: string;
  phoneNumber: string;
  organizationId: string;
  userId: string;
  routingMode: BlueBubblesGatewayRoutingMode;
  agentId: string | null;
  friendlyName: string | null;
  lastSeenAt: Date | null;
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

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hashBlueBubblesGatewayToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function constantTimeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function parseBlueBubblesMetadata(value: string): BlueBubblesGatewayMetadata | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.gatewayKind !== "bluebubbles" ||
      typeof parsed.ownerUserId !== "string" ||
      !parsed.ownerUserId ||
      typeof parsed.authTokenHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.authTokenHash) ||
      typeof parsed.tokenCreatedAt !== "string"
    ) {
      return null;
    }
    if (parsed.schemaVersion === 1 && typeof parsed.agentId === "string" && parsed.agentId) {
      return parsed as LegacyBlueBubblesGatewayMetadata;
    }
    if (
      parsed.schemaVersion === 2 &&
      (parsed.routingMode === "sender-owned" || parsed.routingMode === "fixed-agent") &&
      ((parsed.routingMode === "sender-owned" && parsed.agentId === null) ||
        (parsed.routingMode === "fixed-agent" &&
          typeof parsed.agentId === "string" &&
          parsed.agentId))
    ) {
      return parsed as BlueBubblesGatewayMetadataV2;
    }
    return null;
  } catch {
    // error-policy:J3 malformed persisted metadata is never treated as an authenticated gateway.
    return null;
  }
}

function toAuthenticatedBlueBubblesGateway(
  record: typeof phoneGatewayDevices.$inferSelect,
  metadata: BlueBubblesGatewayMetadata,
): AuthenticatedBlueBubblesGateway | null {
  if (!record.organization_id) return null;
  return {
    id: record.id,
    bridgeId: record.bridge_id,
    phoneNumber: record.phone_number,
    organizationId: record.organization_id,
    userId: metadata.ownerUserId,
    routingMode: metadata.schemaVersion === 1 ? "fixed-agent" : metadata.routingMode,
    agentId: metadata.agentId,
    friendlyName: record.friendly_name,
    lastSeenAt: record.last_seen_at,
  };
}

/**
 * Registers a user-owned BlueBubbles bridge and returns its credential once.
 * Only the SHA-256 digest is persisted; callers must store the returned token
 * on the Mac relay because it cannot be recovered from Cloud later.
 */
export async function createBlueBubblesGatewayRegistration(input: {
  organizationId: string;
  userId: string;
  routingMode: BlueBubblesGatewayRoutingMode;
  agentId?: string | null;
  phoneNumber: string;
  friendlyName?: string | null;
}): Promise<BlueBubblesGatewayRegistration> {
  const agentId = input.routingMode === "fixed-agent" ? input.agentId?.trim() || null : null;
  if (input.routingMode === "fixed-agent" && !agentId) {
    throw new Error("A fixed-agent BlueBubbles gateway requires an agent id");
  }
  const token = `bbg_${randomHex(32)}`;
  const bridgeId = `bb-${crypto.randomUUID()}`;
  const authTokenHash = await hashBlueBubblesGatewayToken(token);
  const metadata: BlueBubblesGatewayMetadataV2 = {
    schemaVersion: 2,
    gatewayKind: "bluebubbles",
    ownerUserId: input.userId,
    routingMode: input.routingMode,
    agentId,
    authTokenHash,
    tokenCreatedAt: new Date().toISOString(),
  };
  const registrationInput: RegisterPhoneGatewayDeviceInput = {
    organizationId: input.organizationId,
    // The existing database enum uses blooio for iMessage bridges. The public
    // contract remains explicitly BlueBubbles through gatewayKind and bridgeId.
    provider: "blooio",
    phoneNumber: input.phoneNumber,
    bridgeId,
    phoneAccountId: input.phoneNumber,
    phoneAccountLabel: input.friendlyName,
    friendlyName: input.friendlyName,
    sendMethod: "bluebubbles-local-bridge",
    metadata,
    markSeen: false,
  };
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    throw new Error("A BlueBubbles gateway requires a valid phone number");
  }

  const registerAtomically = async () =>
    await dbWrite.transaction(async (tx) => {
      const lockKey = `${input.organizationId}:${phoneNumber}:${input.userId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      await tx
        .update(phoneGatewayDevices)
        .set({ is_active: false, updated_at: new Date() })
        .where(
          and(
            eq(phoneGatewayDevices.organization_id, input.organizationId),
            eq(phoneGatewayDevices.provider, "blooio"),
            eq(phoneGatewayDevices.phone_number, phoneNumber),
            eq(phoneGatewayDevices.is_active, true),
            sql`${phoneGatewayDevices.metadata}::jsonb ->> 'gatewayKind' = 'bluebubbles'`,
            sql`${phoneGatewayDevices.metadata}::jsonb ->> 'ownerUserId' = ${input.userId}`,
          ),
        );
      return await upsertPhoneGatewayDevice(registrationInput, tx);
    });

  let registered: RegisterPhoneGatewayDeviceResult;
  try {
    registered = await registerAtomically();
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    await ensurePhoneGatewayDevicesTable();
    registered = await registerAtomically();
  }
  if (!registered.registered || !registered.id) {
    throw new Error(
      `BlueBubbles gateway registration failed: ${registered.skippedReason ?? "unknown"}`,
    );
  }

  return {
    id: registered.id,
    bridgeId,
    token,
    phoneNumber: normalizePhoneNumber(input.phoneNumber),
    organizationId: input.organizationId,
    userId: input.userId,
    routingMode: input.routingMode,
    agentId,
  };
}

export async function authenticateBlueBubblesGateway(
  bridgeId: string,
  token: string,
): Promise<AuthenticatedBlueBubblesGateway | null> {
  if (!bridgeId.trim() || !token.trim()) return null;
  const records = await dbRead
    .select()
    .from(phoneGatewayDevices)
    .where(
      and(
        eq(phoneGatewayDevices.bridge_id, bridgeId.trim()),
        eq(phoneGatewayDevices.provider, "blooio"),
        eq(phoneGatewayDevices.is_active, true),
      ),
    )
    .limit(2);

  const matches = records
    .map((record) => ({ record, metadata: parseBlueBubblesMetadata(record.metadata) }))
    .filter(
      (
        entry,
      ): entry is {
        record: typeof phoneGatewayDevices.$inferSelect;
        metadata: BlueBubblesGatewayMetadata;
      } => entry.metadata !== null,
    );
  if (matches.length !== 1) return null;

  const match = matches[0]!;
  const presentedHash = await hashBlueBubblesGatewayToken(token.trim());
  if (!constantTimeStringEqual(match.metadata.authTokenHash, presentedHash)) {
    return null;
  }
  return toAuthenticatedBlueBubblesGateway(match.record, match.metadata);
}

export async function listBlueBubblesGateways(
  organizationId: string,
  userId: string,
): Promise<AuthenticatedBlueBubblesGateway[]> {
  const records = await dbRead
    .select()
    .from(phoneGatewayDevices)
    .where(
      and(
        eq(phoneGatewayDevices.organization_id, organizationId),
        eq(phoneGatewayDevices.provider, "blooio"),
        eq(phoneGatewayDevices.is_active, true),
      ),
    );

  return records.flatMap((record) => {
    const metadata = parseBlueBubblesMetadata(record.metadata);
    const gateway = metadata ? toAuthenticatedBlueBubblesGateway(record, metadata) : null;
    return gateway?.userId === userId ? [gateway] : [];
  });
}

export async function touchBlueBubblesGateway(gatewayId: string): Promise<void> {
  const now = new Date();
  await dbWrite
    .update(phoneGatewayDevices)
    .set({ last_seen_at: now, updated_at: now })
    .where(eq(phoneGatewayDevices.id, gatewayId));
}

export async function revokeBlueBubblesGateway(
  organizationId: string,
  userId: string,
  gatewayId: string,
): Promise<boolean> {
  // Read ownership from the primary immediately before revocation. A replica
  // can lag just after registration, and org membership alone must not permit
  // one member to revoke another member's local bridge credential.
  const [record] = await dbWrite
    .select()
    .from(phoneGatewayDevices)
    .where(
      and(
        eq(phoneGatewayDevices.id, gatewayId),
        eq(phoneGatewayDevices.organization_id, organizationId),
        eq(phoneGatewayDevices.provider, "blooio"),
        eq(phoneGatewayDevices.is_active, true),
      ),
    )
    .limit(1);
  const metadata = record ? parseBlueBubblesMetadata(record.metadata) : null;
  if (!metadata || metadata.ownerUserId !== userId) return false;

  const [updated] = await dbWrite
    .update(phoneGatewayDevices)
    .set({ is_active: false, updated_at: new Date() })
    .where(
      and(
        eq(phoneGatewayDevices.id, gatewayId),
        eq(phoneGatewayDevices.organization_id, organizationId),
      ),
    )
    .returning({ id: phoneGatewayDevices.id });
  return Boolean(updated);
}

export async function registerPhoneGatewayDevice(
  input: RegisterPhoneGatewayDeviceInput,
): Promise<RegisterPhoneGatewayDeviceResult> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    return { id: null, registered: false, skippedReason: "missing_phone_number" };
  }

  const bridgeId = nullableText(input.bridgeId) ?? "default";
  const upsert = async () => await upsertPhoneGatewayDevice(input, dbWrite);

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
  const metadata = JSON.stringify(input.metadata ?? {});
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

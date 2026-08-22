/** Coordinates cloud phone-gateway registration, authentication, and presence state. */
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { type Database, type DbTransaction, dbRead, dbWrite } from "../../db/client";
import {
  hydratePhoneGatewayDevice,
  phoneGatewayDeviceLosslessSelection,
} from "../../db/repositories/phone-metadata-readers";
import { phoneGatewayDevices } from "../../db/schemas/phone-gateway-devices";
import { logger } from "../utils/logger";
import { normalizePhoneNumber } from "../utils/phone-normalization";
import { isPostgresUndefinedTableError, phoneErrorDiagnostic } from "./phone-error-diagnostics";
import { PHONE_GATEWAY_METADATA_INVALID, requirePhoneJsonObject } from "./phone-payload-validation";

export type PhoneGatewayProvider = "twilio" | "blooio" | "vonage" | "other";

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

function providerDiagnostic(value: unknown): string {
  return value === "twilio" || value === "blooio" || value === "vonage" || value === "other"
    ? value
    : "unknown";
}

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

async function withPhoneGatewaySchema<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUndefinedTableError(error)) throw schemaMigrationRequired(error);
    throw error;
  }
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

function parseBlueBubblesMetadata(value: unknown): BlueBubblesGatewayMetadata | null {
  try {
    const parsed = requirePhoneJsonObject(value, {
      field: "phone_gateway_devices.metadata",
      code: PHONE_GATEWAY_METADATA_INVALID,
    });
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
      // A phone identity represents one physical relay for an organization.
      // Rotation must therefore serialize across administrators, not only the
      // user who happened to issue the previous credential.
      const lockKey = `${input.organizationId}:${phoneNumber}`;
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
            sql`${phoneGatewayDevices.metadata} ->> 'gatewayKind' = 'bluebubbles'`,
          ),
        );
      return await upsertPhoneGatewayDevice(registrationInput, tx);
    });

  let registered: RegisterPhoneGatewayDeviceResult;
  try {
    registered = await registerAtomically();
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    // error-policy:J2 request-serving code must not synthesize a divergent table.
    throw schemaMigrationRequired(error);
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
  const rawRecords = await withPhoneGatewaySchema(() =>
    dbRead
      .select(phoneGatewayDeviceLosslessSelection)
      .from(phoneGatewayDevices)
      .where(
        and(
          eq(phoneGatewayDevices.bridge_id, bridgeId.trim()),
          eq(phoneGatewayDevices.provider, "blooio"),
          eq(phoneGatewayDevices.is_active, true),
        ),
      )
      .limit(2),
  );
  const records = rawRecords.map(hydratePhoneGatewayDevice);

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
  const rawRecords = await withPhoneGatewaySchema(() =>
    dbRead
      .select(phoneGatewayDeviceLosslessSelection)
      .from(phoneGatewayDevices)
      .where(
        and(
          eq(phoneGatewayDevices.organization_id, organizationId),
          eq(phoneGatewayDevices.provider, "blooio"),
          eq(phoneGatewayDevices.is_active, true),
        ),
      ),
  );
  const records = rawRecords.map(hydratePhoneGatewayDevice);

  return records.flatMap((record) => {
    const metadata = parseBlueBubblesMetadata(record.metadata);
    const gateway = metadata ? toAuthenticatedBlueBubblesGateway(record, metadata) : null;
    return gateway?.userId === userId ? [gateway] : [];
  });
}

export async function touchBlueBubblesGateway(gatewayId: string): Promise<void> {
  const now = new Date();
  await withPhoneGatewaySchema(() =>
    dbWrite
      .update(phoneGatewayDevices)
      .set({ last_seen_at: now, updated_at: now })
      .where(eq(phoneGatewayDevices.id, gatewayId)),
  );
}

export async function revokeBlueBubblesGateway(
  organizationId: string,
  userId: string,
  gatewayId: string,
): Promise<boolean> {
  return await withPhoneGatewaySchema(async () => {
    // Read ownership from the primary immediately before revocation. A replica
    // can lag just after registration, and org membership alone must not permit
    // one member to revoke another member's local bridge credential.
    const [rawRecord] = await dbWrite
      .select(phoneGatewayDeviceLosslessSelection)
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
    const record = rawRecord ? hydratePhoneGatewayDevice(rawRecord) : null;
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
  });
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

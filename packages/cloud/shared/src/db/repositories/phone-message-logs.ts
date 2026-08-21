/**
 * Owns phone-message JSONB writes and tenant-authorized payload hydration.
 * Pointer-backed values are never exposed from this repository as authoritative
 * payloads: every R2 key must match the row's tenant, id, date, and field.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePhoneJsonLosslessly } from "../../lib/services/phone-lossless-json";
import {
  PHONE_MESSAGE_MEDIA_URLS_INVALID,
  PHONE_STORED_JSON_INVALID,
  requirePhoneJsonObject,
  validatePhoneMediaUrls,
  validatePhoneMessageMetadata,
} from "../../lib/services/phone-payload-validation";
import { ObjectNamespaces } from "../../lib/storage/object-namespace";
import {
  buildObjectFieldKey,
  hydrateJsonField,
  hydrateTextField,
  type OffloadedField,
  offloadJsonField,
  offloadTextField,
} from "../../lib/storage/object-store";
import { dbRead, dbWrite } from "../client";
import {
  agentPhoneNumbers,
  type NewPhoneMessageLog,
  type PhoneMessageLog,
  phoneMessageLog,
} from "../schemas/agent-phone-numbers";

export const PHONE_MESSAGE_POINTER_INVALID = "PHONE_MESSAGE_POINTER_INVALID";
export const PHONE_MESSAGE_PAYLOAD_UNAVAILABLE = "PHONE_MESSAGE_PAYLOAD_UNAVAILABLE";
export const PHONE_MESSAGE_NOT_FOUND = "PHONE_MESSAGE_NOT_FOUND";
export const PHONE_MESSAGE_OWNER_NOT_FOUND = "PHONE_MESSAGE_OWNER_NOT_FOUND";
export const PHONE_MESSAGE_WRITE_CONFLICT = "PHONE_MESSAGE_WRITE_CONFLICT";

type PhonePayloadField = "message_body" | "media_urls" | "agent_response" | "metadata";
type NewTenantPhoneMessageLog = Omit<NewPhoneMessageLog, "organization_id">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pointerError(field: PhonePayloadField, rule: string): ElizaError {
  return new ElizaError("Phone message payload pointer is invalid", {
    code: PHONE_MESSAGE_POINTER_INVALID,
    context: { field, rule },
  });
}

function normalizePointerIdentity(value: string, field: "organization_id" | "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ElizaError("Phone message payload identity is not a canonical UUID", {
      code: PHONE_MESSAGE_POINTER_INVALID,
      context: { field, rule: "canonical_uuid" },
    });
  }
  return value.toLowerCase();
}

function requireCreatedAt(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ElizaError("Phone message payload timestamp is invalid", {
      code: PHONE_MESSAGE_POINTER_INVALID,
      context: { field: "created_at", rule: "valid_date" },
    });
  }
}

function expectedPayloadKey(input: {
  organizationId: string;
  messageLogId: string;
  createdAt: Date;
  field: PhonePayloadField;
  extension: "json" | "txt";
  version?: string;
}): string {
  const organizationId = normalizePointerIdentity(input.organizationId, "organization_id");
  const messageLogId = normalizePointerIdentity(input.messageLogId, "id");
  requireCreatedAt(input.createdAt);
  return buildObjectFieldKey({
    namespace: ObjectNamespaces.PhoneMessagePayloads,
    organizationId,
    objectId: messageLogId,
    field: input.field,
    createdAt: input.createdAt,
    extension: input.extension,
    ...(input.version ? { version: input.version } : {}),
  });
}

function isAuthorizedPayloadKey(input: {
  key: string;
  organizationId: string;
  messageLogId: string;
  createdAt: Date;
  field: PhonePayloadField;
  extension: "json" | "txt";
}): boolean {
  const legacyKey = expectedPayloadKey(input);
  if (input.key === legacyKey) return true;
  const prefix = legacyKey.slice(0, -input.extension.length);
  const suffix = `.${input.extension}`;
  if (input.key.startsWith(prefix) && input.key.endsWith(suffix)) {
    const version = input.key.slice(prefix.length, -suffix.length);
    if (LOWERCASE_UUID_PATTERN.test(version)) return true;
  }

  // Before these columns became JSONB, media_urls and metadata were serialized
  // strings and offloaded through offloadTextField. Their deterministic keys
  // therefore end in .txt even though the stored object body contains JSON.
  return (
    input.extension === "json" &&
    (input.field === "media_urls" || input.field === "metadata") &&
    input.key === expectedPayloadKey({ ...input, extension: "txt" })
  );
}

function assertPointerAuthority(input: {
  storage: string | null | undefined;
  key: string | null | undefined;
  organizationId: string;
  messageLogId: string;
  createdAt: Date;
  extension: "json" | "txt";
  field: PhonePayloadField;
}): "inline" | "r2" {
  const storage = input.storage ?? "inline";
  if (storage === "inline") {
    if (input.key !== null && input.key !== undefined) {
      throw pointerError(input.field, "inline_key_must_be_null");
    }
    return storage;
  }
  if (storage !== "r2") throw pointerError(input.field, "unsupported_storage_mode");
  if (!input.key) throw pointerError(input.field, "r2_key_required");
  if (!isAuthorizedPayloadKey({ ...input, key: input.key })) {
    throw pointerError(input.field, "exact_key_mismatch");
  }
  return storage;
}

function requireNullableText(value: unknown, field: PhonePayloadField): string | null | undefined {
  if (value === null || value === undefined || typeof value === "string") return value;
  throw new ElizaError("Phone message text payload must be a string", {
    code: "PHONE_MESSAGE_TEXT_INVALID",
    context: { field, rule: "nullable_string" },
  });
}

function rejectPointerJsonNull<T>(input: {
  value: T | null;
  storage: string;
  field: "media_urls" | "metadata";
  code: string;
}): T | null {
  if (input.storage === "r2" && input.value === null) {
    throw new ElizaError("Phone message object payload has an invalid JSON null body", {
      code: input.code,
      context: { field: input.field, rule: "pointer_json_non_null" },
    });
  }
  return input.value;
}

async function prepareTextField(input: {
  organizationId: string;
  messageLogId: string;
  createdAt: Date;
  field: "message_body" | "agent_response";
  value: string | null | undefined;
  storage: string | null | undefined;
  key: string | null | undefined;
  writeVersion: string;
}): Promise<OffloadedField<string>> {
  const storage = assertPointerAuthority({ ...input, extension: "txt" });
  if (storage === "r2") {
    return { value: input.value ?? null, storage, key: input.key! };
  }
  return offloadTextField({
    namespace: ObjectNamespaces.PhoneMessagePayloads,
    organizationId: input.organizationId,
    objectId: input.messageLogId,
    field: input.field,
    createdAt: input.createdAt,
    value: input.value,
    version: input.writeVersion,
    immutable: true,
  });
}

async function prepareJsonField<T>(input: {
  organizationId: string;
  messageLogId: string;
  createdAt: Date;
  field: "media_urls" | "metadata";
  value: T | null;
  storage: string | null | undefined;
  key: string | null | undefined;
  inlineValueWhenOffloaded: T;
  writeVersion: string;
}): Promise<OffloadedField<T>> {
  const storage = assertPointerAuthority({ ...input, extension: "json" });
  if (storage === "r2") {
    return { value: input.value, storage, key: input.key! };
  }
  return offloadJsonField<T>({
    namespace: ObjectNamespaces.PhoneMessagePayloads,
    organizationId: input.organizationId,
    objectId: input.messageLogId,
    field: input.field,
    createdAt: input.createdAt,
    value: input.value,
    inlineValueWhenOffloaded: input.inlineValueWhenOffloaded,
    version: input.writeVersion,
    immutable: true,
  });
}

/** Validate and independently offload every mutable phone-message payload field. */
async function preparePhoneMessagePayload(
  data: NewTenantPhoneMessageLog,
  organizationId: string,
): Promise<NewPhoneMessageLog> {
  const normalizedOrganizationId = normalizePointerIdentity(organizationId, "organization_id");
  const id = normalizePointerIdentity(data.id ?? randomUUID(), "id");
  const createdAt = data.created_at ?? new Date();
  const writeVersion = randomUUID().toLowerCase();
  const messageBodyValue = requireNullableText(data.message_body, "message_body");
  const agentResponseValue = requireNullableText(data.agent_response, "agent_response");
  const mediaUrlsValue = validatePhoneMediaUrls(data.media_urls);
  const metadataValue = validatePhoneMessageMetadata(data.metadata);

  // Validate every pointer before starting any object write. This keeps a bad
  // field from racing valid sibling offloads and leaving avoidable orphans.
  for (const pointer of [
    {
      field: "message_body" as const,
      storage: data.message_body_storage,
      key: data.message_body_key,
      extension: "txt" as const,
    },
    {
      field: "media_urls" as const,
      storage: data.media_urls_storage,
      key: data.media_urls_key,
      extension: "json" as const,
    },
    {
      field: "agent_response" as const,
      storage: data.agent_response_storage,
      key: data.agent_response_key,
      extension: "txt" as const,
    },
    {
      field: "metadata" as const,
      storage: data.metadata_storage,
      key: data.metadata_key,
      extension: "json" as const,
    },
  ]) {
    assertPointerAuthority({
      field: pointer.field,
      storage: pointer.storage,
      key: pointer.key,
      organizationId: normalizedOrganizationId,
      messageLogId: id,
      createdAt,
      extension: pointer.extension,
    });
  }

  const [messageBody, mediaUrls, agentResponse, metadata] = await Promise.all([
    prepareTextField({
      organizationId: normalizedOrganizationId,
      messageLogId: id,
      createdAt,
      field: "message_body",
      value: messageBodyValue,
      storage: data.message_body_storage,
      key: data.message_body_key,
      writeVersion,
    }),
    prepareJsonField<string[]>({
      organizationId: normalizedOrganizationId,
      messageLogId: id,
      createdAt,
      field: "media_urls",
      value: mediaUrlsValue,
      storage: data.media_urls_storage,
      key: data.media_urls_key,
      inlineValueWhenOffloaded: [],
      writeVersion,
    }),
    prepareTextField({
      organizationId: normalizedOrganizationId,
      messageLogId: id,
      createdAt,
      field: "agent_response",
      value: agentResponseValue,
      storage: data.agent_response_storage,
      key: data.agent_response_key,
      writeVersion,
    }),
    prepareJsonField<Record<string, unknown>>({
      organizationId: normalizedOrganizationId,
      messageLogId: id,
      createdAt,
      field: "metadata",
      value: metadataValue,
      storage: data.metadata_storage,
      key: data.metadata_key,
      inlineValueWhenOffloaded: {},
      writeVersion,
    }),
  ]);

  return {
    ...data,
    id,
    organization_id: normalizedOrganizationId,
    created_at: createdAt,
    message_body: messageBody.value,
    message_body_storage: messageBody.storage,
    message_body_key: messageBody.key,
    media_urls: mediaUrls.value,
    media_urls_storage: mediaUrls.storage,
    media_urls_key: mediaUrls.key,
    agent_response: agentResponse.value,
    agent_response_storage: agentResponse.storage,
    agent_response_key: agentResponse.key,
    metadata: metadata.value,
    metadata_storage: metadata.storage,
    metadata_key: metadata.key,
  };
}

async function hydratePayloadField<T>(
  field: PhonePayloadField,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    // error-policy:J2 add a bounded phone-domain field while preserving storage failure authority.
    throw new ElizaError("Phone message payload is unavailable", {
      code: PHONE_MESSAGE_PAYLOAD_UNAVAILABLE,
      context: { field },
      cause,
    });
  }
}

/** Hydrate one tenant-authorized row and reject every incomplete or mismatched pointer. */
async function hydratePhoneMessageLog(
  row: PhoneMessageLog,
  organizationId: string,
  rawMetadataJson: string | null,
): Promise<PhoneMessageLog> {
  const normalizedOrganizationId = normalizePointerIdentity(organizationId, "organization_id");
  const normalizedMessageLogId = normalizePointerIdentity(row.id, "id");
  const fieldContexts = {
    message_body: {
      storage: row.message_body_storage,
      key: row.message_body_key,
      extension: "txt" as const,
    },
    media_urls: {
      storage: row.media_urls_storage,
      key: row.media_urls_key,
      extension: "json" as const,
    },
    agent_response: {
      storage: row.agent_response_storage,
      key: row.agent_response_key,
      extension: "txt" as const,
    },
    metadata: {
      storage: row.metadata_storage,
      key: row.metadata_key,
      extension: "json" as const,
    },
  } as const;

  for (const field of Object.keys(fieldContexts) as PhonePayloadField[]) {
    assertPointerAuthority({
      field,
      ...fieldContexts[field],
      organizationId: normalizedOrganizationId,
      messageLogId: normalizedMessageLogId,
      createdAt: row.created_at,
    });
  }

  const [messageBody, mediaUrls, agentResponse, metadata] = await Promise.all([
    hydratePayloadField("message_body", () =>
      hydrateTextField({
        storage: row.message_body_storage,
        key: row.message_body_key,
        inlineValue: row.message_body,
        strict: true,
      }),
    ),
    hydratePayloadField("media_urls", () =>
      hydrateJsonField<unknown>({
        storage: row.media_urls_storage,
        key: row.media_urls_key,
        inlineValue: row.media_urls,
        strict: true,
      }),
    ),
    hydratePayloadField("agent_response", () =>
      hydrateTextField({
        storage: row.agent_response_storage,
        key: row.agent_response_key,
        inlineValue: row.agent_response,
        strict: true,
      }),
    ),
    hydratePayloadField("metadata", async () => {
      const raw = await hydrateTextField({
        storage: row.metadata_storage,
        key: row.metadata_key,
        inlineValue: rawMetadataJson,
        strict: true,
      });
      return raw === null ? null : parsePhoneJsonLosslessly(raw);
    }),
  ]);

  const hydratedMediaUrls = rejectPointerJsonNull({
    value: mediaUrls,
    storage: row.media_urls_storage,
    field: "media_urls",
    code: PHONE_MESSAGE_MEDIA_URLS_INVALID,
  });
  const hydratedMetadata = rejectPointerJsonNull({
    value: metadata,
    storage: row.metadata_storage,
    field: "metadata",
    code: PHONE_STORED_JSON_INVALID,
  });

  return {
    ...row,
    message_body: messageBody,
    media_urls: validatePhoneMediaUrls(hydratedMediaUrls),
    agent_response: agentResponse,
    metadata:
      hydratedMetadata === null
        ? null
        : requirePhoneJsonObject(hydratedMetadata, { field: "metadata" }),
  };
}

class PhoneMessageLogsRepository {
  async create(data: NewTenantPhoneMessageLog, organizationId: string): Promise<string> {
    const normalizedOrganizationId = normalizePointerIdentity(organizationId, "organization_id");
    const normalizedPhoneNumberId = normalizePointerIdentity(data.phone_number_id, "id");
    const [ownedPhoneNumber] = await dbWrite
      .select({ id: agentPhoneNumbers.id })
      .from(agentPhoneNumbers)
      .where(
        and(
          eq(agentPhoneNumbers.id, normalizedPhoneNumberId),
          eq(agentPhoneNumbers.organization_id, normalizedOrganizationId),
        ),
      )
      .limit(1);
    if (!ownedPhoneNumber) {
      throw new ElizaError("Phone message owner was not found", {
        code: PHONE_MESSAGE_OWNER_NOT_FOUND,
      });
    }

    const insertData = await preparePhoneMessagePayload(
      { ...data, phone_number_id: normalizedPhoneNumberId },
      normalizedOrganizationId,
    );

    // Keep object-store I/O outside the database transaction, then close the
    // ownership race by locking the phone-number row and inserting the message
    // in one transaction. A concurrent tenant reassignment either commits
    // before this SELECT (and fails the predicate) or waits until after INSERT.
    const [created] = await dbWrite.transaction(async (tx) => {
      const [ownedPhoneNumberAtInsert] = await tx
        .select({ id: agentPhoneNumbers.id })
        .from(agentPhoneNumbers)
        .where(
          and(
            eq(agentPhoneNumbers.id, normalizedPhoneNumberId),
            eq(agentPhoneNumbers.organization_id, normalizedOrganizationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!ownedPhoneNumberAtInsert) {
        throw new ElizaError("Phone message owner was not found", {
          code: PHONE_MESSAGE_OWNER_NOT_FOUND,
        });
      }

      return tx.insert(phoneMessageLog).values(insertData).returning({ id: phoneMessageLog.id });
    });
    if (!created) {
      throw new ElizaError("Phone message insert returned no row", {
        code: "PHONE_MESSAGE_INSERT_FAILED",
      });
    }
    return created.id;
  }

  async findHydratedById(
    organizationId: string,
    messageLogId: string,
  ): Promise<PhoneMessageLog | null> {
    const normalizedOrganizationId = normalizePointerIdentity(organizationId, "organization_id");
    const normalizedMessageLogId = normalizePointerIdentity(messageLogId, "id");
    const [result] = await dbRead
      .select({
        message: phoneMessageLog,
        rawMetadataJson: sql<string | null>`${phoneMessageLog.metadata}::text`,
      })
      .from(phoneMessageLog)
      .where(
        and(
          eq(phoneMessageLog.id, normalizedMessageLogId),
          eq(phoneMessageLog.organization_id, normalizedOrganizationId),
        ),
      )
      .limit(1);
    return result
      ? await hydratePhoneMessageLog(
          result.message,
          normalizedOrganizationId,
          result.rawMetadataJson,
        )
      : null;
  }

  async updateAgentResponse(
    organizationId: string,
    messageLogId: string,
    response: string,
    responseTimeMs: number,
  ): Promise<void> {
    const normalizedOrganizationId = normalizePointerIdentity(organizationId, "organization_id");
    const normalizedMessageLogId = normalizePointerIdentity(messageLogId, "id");
    if (
      typeof response !== "string" ||
      !Number.isSafeInteger(responseTimeMs) ||
      responseTimeMs < 0
    ) {
      throw new ElizaError("Phone message response update is invalid", {
        code: "PHONE_MESSAGE_RESPONSE_INVALID",
      });
    }

    const [context] = await dbWrite
      .select({
        organizationId: phoneMessageLog.organization_id,
        createdAt: phoneMessageLog.created_at,
        previousResponse: phoneMessageLog.agent_response,
        previousStorage: phoneMessageLog.agent_response_storage,
        previousKey: phoneMessageLog.agent_response_key,
      })
      .from(phoneMessageLog)
      .where(
        and(
          eq(phoneMessageLog.id, normalizedMessageLogId),
          eq(phoneMessageLog.organization_id, normalizedOrganizationId),
        ),
      )
      .limit(1);
    if (!context) {
      throw new ElizaError("Phone message response target was not found", {
        code: PHONE_MESSAGE_NOT_FOUND,
      });
    }

    const agentResponse = await prepareTextField({
      organizationId: context.organizationId,
      messageLogId: normalizedMessageLogId,
      createdAt: context.createdAt,
      field: "agent_response",
      value: response,
      storage: "inline",
      key: null,
      writeVersion: randomUUID().toLowerCase(),
    });
    const [updated] = await dbWrite
      .update(phoneMessageLog)
      .set({
        status: "responded",
        agent_response: agentResponse.value,
        agent_response_storage: agentResponse.storage,
        agent_response_key: agentResponse.key,
        response_time_ms: responseTimeMs.toString(),
        responded_at: new Date(),
      })
      .where(
        and(
          eq(phoneMessageLog.id, normalizedMessageLogId),
          eq(phoneMessageLog.organization_id, normalizedOrganizationId),
          eq(phoneMessageLog.agent_response_storage, context.previousStorage),
          context.previousKey === null
            ? isNull(phoneMessageLog.agent_response_key)
            : eq(phoneMessageLog.agent_response_key, context.previousKey),
          context.previousResponse === null
            ? isNull(phoneMessageLog.agent_response)
            : eq(phoneMessageLog.agent_response, context.previousResponse),
        ),
      )
      .returning({ id: phoneMessageLog.id });
    if (!updated) {
      throw new ElizaError("Phone message response changed concurrently", {
        code: PHONE_MESSAGE_WRITE_CONFLICT,
      });
    }
  }

  async markFailed(
    organizationId: string,
    messageLogId: string,
    errorMessage: string,
  ): Promise<void> {
    const normalizedOrganizationId = normalizePointerIdentity(organizationId, "organization_id");
    const normalizedMessageLogId = normalizePointerIdentity(messageLogId, "id");
    const [updated] = await dbWrite
      .update(phoneMessageLog)
      .set({ status: "failed", error_message: errorMessage })
      .where(
        and(
          eq(phoneMessageLog.id, normalizedMessageLogId),
          eq(phoneMessageLog.organization_id, normalizedOrganizationId),
        ),
      )
      .returning({ id: phoneMessageLog.id });
    if (!updated) {
      throw new ElizaError("Phone message failure target was not found", {
        code: PHONE_MESSAGE_NOT_FOUND,
      });
    }
  }
}

export const phoneMessageLogsRepository = new PhoneMessageLogsRepository();

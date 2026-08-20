/**
 * Defines and validates the versioned declarative state shared by every
 * synthetic-world execution profile, including provider-owned fixture data.
 */
import { z } from "zod";

export const SYNTHETIC_WORLD_SCHEMA_VERSION = "1.0.0" as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

const id = z.string().min(1).max(256);
const timestamp = z.iso.datetime({ offset: true });
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const baseEntity = z.object({ id }).strict();

export const faultEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("latency"),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("timeout"),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("disconnect") }).strict(),
  z.object({ kind: z.literal("malformedData"), value: jsonValue }).strict(),
  z.object({ kind: z.literal("authExpired") }).strict(),
  z
    .object({
      kind: z.literal("rateLimit"),
      retryAfterMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("partialResponse"),
      omitFields: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ kind: z.literal("ambiguousCommit") }).strict(),
  z
    .object({
      kind: z.literal("retry"),
      retryAfterMs: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("recovery") }).strict(),
]);

export const faultScriptSchema = z
  .object({
    id,
    boundary: z.string().min(1),
    steps: z
      .array(
        z
          .object({
            onAttempt: z.number().int().positive(),
            effect: faultEffectSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const identitySchema = baseEntity
  .extend({
    kind: z.enum(["person", "service"]),
    displayName: z.string().min(1),
    email: z.email().optional(),
    phone: z.string().min(3).optional(),
    attributes: z.record(z.string(), jsonValue).optional(),
  })
  .strict();

const organizationSchema = baseEntity
  .extend({
    name: z.string().min(1),
    memberIdentityIds: z.array(id),
    attributes: z.record(z.string(), jsonValue).optional(),
  })
  .strict();

const agentSchema = baseEntity
  .extend({
    name: z.string().min(1),
    ownerIdentityId: id,
    organizationId: id.optional(),
    settings: z.record(z.string(), jsonValue).optional(),
  })
  .strict();

const roomSchema = baseEntity
  .extend({
    kind: z.enum(["direct", "group", "channel"]),
    participantIdentityIds: z.array(id),
    connectorAccountId: id.optional(),
    externalId: z.string().min(1).optional(),
  })
  .strict();

const threadSchema = baseEntity
  .extend({
    roomId: id,
    title: z.string().min(1).optional(),
    participantIdentityIds: z.array(id).optional(),
    externalId: z.string().min(1).optional(),
  })
  .strict();

const messageSchema = baseEntity
  .extend({
    roomId: id,
    senderIdentityId: id,
    body: z.string(),
    sentAt: timestamp,
    threadId: id.optional(),
    replyToMessageId: id.optional(),
    mediaIds: z.array(id).optional(),
    metadata: z.record(z.string(), jsonValue).optional(),
  })
  .strict();

const grantSchema = baseEntity
  .extend({
    subjectIdentityId: id,
    scopes: z.array(z.string().min(1)),
    grantedAt: timestamp,
    expiresAt: timestamp.optional(),
    revokedAt: timestamp.optional(),
  })
  .strict();

const connectorAccountSchema = baseEntity
  .extend({
    provider: z.string().min(1),
    ownerIdentityId: id,
    grantIds: z.array(id),
    status: z.enum(["connected", "expired", "revoked", "error"]),
    externalAccountId: z.string().min(1),
    expiresAt: timestamp.optional(),
    fixture: jsonValue.optional(),
  })
  .strict();

const calendarSchema = baseEntity
  .extend({
    ownerIdentityId: id,
    name: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();
const calendarEventSchema = baseEntity
  .extend({
    calendarId: id,
    title: z.string().min(1),
    startsAt: timestamp,
    endsAt: timestamp,
    attendeeIdentityIds: z.array(id),
    recurrence: z.string().min(1).optional(),
  })
  .strict();
const taskSchema = baseEntity
  .extend({
    ownerIdentityId: id,
    title: z.string().min(1),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    dueAt: timestamp.optional(),
    payload: jsonValue.optional(),
  })
  .strict();
const reminderSchema = baseEntity
  .extend({
    taskId: id.optional(),
    ownerIdentityId: id,
    message: z.string().min(1),
    fireAt: timestamp,
    status: z.enum([
      "scheduled",
      "delivered",
      "acknowledged",
      "dismissed",
      "cancelled",
    ]),
  })
  .strict();
const contactSchema = baseEntity
  .extend({
    ownerIdentityId: id,
    identityId: id,
    notes: z.string().optional(),
    tags: z.array(z.string()),
  })
  .strict();
const relationshipSchema = baseEntity
  .extend({
    fromIdentityId: id,
    toIdentityId: id,
    kind: z.string().min(1),
    attributes: z.record(z.string(), jsonValue).optional(),
  })
  .strict();
const memorySchema = baseEntity
  .extend({
    agentId: id,
    ownerIdentityId: id.optional(),
    roomId: id.optional(),
    content: jsonValue,
    createdAt: timestamp,
  })
  .strict();
const approvalSchema = baseEntity
  .extend({
    requesterIdentityId: id,
    approverIdentityId: id,
    action: z.string().min(1),
    status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]),
    requestedAt: timestamp,
    decidedAt: timestamp.optional(),
    payload: jsonValue.optional(),
  })
  .strict();
const outboxEntrySchema = baseEntity
  .extend({
    target: z.string().min(1),
    payload: jsonValue,
    status: z.enum(["pending", "sending", "sent", "failed", "cancelled"]),
    idempotencyKey: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    availableAt: timestamp,
  })
  .strict();
const notificationSchema = baseEntity
  .extend({
    recipientIdentityId: id,
    channel: z.string().min(1),
    body: z.string(),
    status: z.enum(["queued", "delivered", "read", "failed", "cancelled"]),
    deliverAt: timestamp,
  })
  .strict();
const mediaSchema = baseEntity
  .extend({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    url: z.url(),
  })
  .strict();
const billingAccountSchema = baseEntity
  .extend({
    ownerIdentityId: id,
    currency: z.string().length(3),
    balanceMinor: z.number().int(),
  })
  .strict();
const billingTransactionSchema = baseEntity
  .extend({
    accountId: id,
    amountMinor: z.number().int(),
    currency: z.string().length(3),
    kind: z.string().min(1),
    occurredAt: timestamp,
    externalId: z.string().min(1).optional(),
  })
  .strict();
const providerStateSchema = baseEntity
  .extend({ provider: z.string().min(1), state: jsonValue })
  .strict();
const backgroundJobSchema = baseEntity
  .extend({
    queue: z.string().min(1),
    kind: z.string().min(1),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    runAt: timestamp,
    attempts: z.number().int().nonnegative(),
    payload: jsonValue,
  })
  .strict();

export const worldDataSchema = z
  .object({
    identities: z.array(identitySchema).default([]),
    organizations: z.array(organizationSchema).default([]),
    agents: z.array(agentSchema).default([]),
    rooms: z.array(roomSchema).default([]),
    threads: z.array(threadSchema).default([]),
    messages: z.array(messageSchema).default([]),
    connectorAccounts: z.array(connectorAccountSchema).default([]),
    grants: z.array(grantSchema).default([]),
    calendars: z.array(calendarSchema).default([]),
    calendarEvents: z.array(calendarEventSchema).default([]),
    tasks: z.array(taskSchema).default([]),
    reminders: z.array(reminderSchema).default([]),
    contacts: z.array(contactSchema).default([]),
    relationships: z.array(relationshipSchema).default([]),
    memories: z.array(memorySchema).default([]),
    approvals: z.array(approvalSchema).default([]),
    outbox: z.array(outboxEntrySchema).default([]),
    notifications: z.array(notificationSchema).default([]),
    media: z.array(mediaSchema).default([]),
    billingAccounts: z.array(billingAccountSchema).default([]),
    billingTransactions: z.array(billingTransactionSchema).default([]),
    providerState: z.array(providerStateSchema).default([]),
    backgroundJobs: z.array(backgroundJobSchema).default([]),
    extensions: z.record(z.string(), jsonValue).default({}),
  })
  .strict();

export const worldManifestSchema = z
  .object({
    schemaVersion: z.literal(SYNTHETIC_WORLD_SCHEMA_VERSION),
    worldId: id,
    seed: z.string().min(1),
    clock: z.object({ epoch: timestamp, timezone: z.string().min(1) }).strict(),
    fixturePolicy: z
      .object({
        allowedEmailDomains: z
          .array(z.string().min(1))
          .default(["example.com", "example.invalid"]),
        allowedUrlHosts: z
          .array(z.string().min(1))
          .default([
            "example.com",
            "example.invalid",
            "localhost",
            "127.0.0.1",
          ]),
      })
      .strict()
      .default({
        allowedEmailDomains: ["example.com", "example.invalid"],
        allowedUrlHosts: [
          "example.com",
          "example.invalid",
          "localhost",
          "127.0.0.1",
        ],
      }),
    data: worldDataSchema,
    faults: z.array(faultScriptSchema).default([]),
  })
  .strict();

export type FaultEffect = z.infer<typeof faultEffectSchema>;
export type FaultScript = z.infer<typeof faultScriptSchema>;
export type WorldData = z.infer<typeof worldDataSchema>;
export type WorldManifest = z.infer<typeof worldManifestSchema>;

const credentialKey =
  /(api[-_]?key|access[-_]?token|refresh[-_]?token|password|client[-_]?secret|private[-_]?key)/i;
const obviousSyntheticSecret =
  /^(mock|synthetic|test|example|redacted|fake)([-_:].*)?$/i;
const credentialPattern =
  /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk_live_[A-Za-z0-9]+|\bghp_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]+)/;
const syntheticPhone =
  /^(?:\+?1[- .]?)?(?:555|[2-9]\d{2}[- .]?555)[- .]?\d{4}$/;

export class UnsafeFixtureError extends Error {
  public readonly findings: readonly string[];

  public constructor(findings: readonly string[]) {
    super(
      `Synthetic-world fixture safety validation failed:\n${findings.join("\n")}`,
    );
    this.name = "UnsafeFixtureError";
    this.findings = findings;
  }
}

function inspectFixtureValue(
  value: JsonValue,
  path: string,
  policy: WorldManifest["fixturePolicy"],
  findings: string[],
): void {
  if (typeof value === "string") {
    if (credentialPattern.test(value))
      findings.push(`${path}: resembles a production credential`);
    const emailMatch = value.match(/^[^@\s]+@([^@\s]+)$/);
    if (
      emailMatch &&
      !policy.allowedEmailDomains.includes(emailMatch[1].toLowerCase())
    ) {
      findings.push(`${path}: email domain is not allowed by fixturePolicy`);
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const hostname = new URL(value).hostname.toLowerCase();
        if (!policy.allowedUrlHosts.includes(hostname))
          findings.push(`${path}: URL host is not allowed by fixturePolicy`);
      } catch {
        // error-policy:J3 Fixture strings resembling malformed URLs are explicitly invalid.
        findings.push(`${path}: URL is malformed`);
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries())
      inspectFixtureValue(child, `${path}[${index}]`, policy, findings);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      credentialKey.test(key) &&
      typeof child === "string" &&
      !obviousSyntheticSecret.test(child)
    ) {
      findings.push(
        `${childPath}: credential-like fields must contain an obvious synthetic value`,
      );
    }
    inspectFixtureValue(child, childPath, policy, findings);
  }
}

function validateReferences(manifest: WorldManifest, findings: string[]): void {
  const { extensions: _extensions, ...entityCollections } = manifest.data;
  for (const [collection, entities] of Object.entries(entityCollections)) {
    const seen = new Set<string>();
    for (const entity of entities) {
      if (seen.has(entity.id))
        findings.push(`$.data.${collection}: duplicate id ${entity.id}`);
      seen.add(entity.id);
    }
  }

  const identities = new Set(manifest.data.identities.map(({ id }) => id));
  const organizations = new Set(
    manifest.data.organizations.map(({ id }) => id),
  );
  const agents = new Set(manifest.data.agents.map(({ id }) => id));
  const rooms = new Set(manifest.data.rooms.map(({ id }) => id));
  const threads = new Set(manifest.data.threads.map(({ id }) => id));
  const messages = new Set(manifest.data.messages.map(({ id }) => id));
  const tasks = new Set(manifest.data.tasks.map(({ id }) => id));
  const calendars = new Set(manifest.data.calendars.map(({ id }) => id));
  const media = new Set(manifest.data.media.map(({ id }) => id));
  const accounts = new Set(manifest.data.billingAccounts.map(({ id }) => id));
  const grants = new Set(manifest.data.grants.map(({ id }) => id));
  const connectors = new Set(
    manifest.data.connectorAccounts.map(({ id }) => id),
  );

  const requireId = (
    set: ReadonlySet<string>,
    value: string,
    path: string,
  ): void => {
    if (!set.has(value)) findings.push(`${path}: unknown reference ${value}`);
  };
  for (const [index, identity] of manifest.data.identities.entries()) {
    if (identity.phone && !syntheticPhone.test(identity.phone)) {
      findings.push(
        `$.data.identities[${index}].phone: must use a reserved 555 synthetic number`,
      );
    }
  }
  for (const [index, agent] of manifest.data.agents.entries()) {
    requireId(
      identities,
      agent.ownerIdentityId,
      `$.data.agents[${index}].ownerIdentityId`,
    );
    if (agent.organizationId)
      requireId(
        organizations,
        agent.organizationId,
        `$.data.agents[${index}].organizationId`,
      );
  }
  for (const [index, organization] of manifest.data.organizations.entries()) {
    for (const identityId of organization.memberIdentityIds)
      requireId(
        identities,
        identityId,
        `$.data.organizations[${index}].memberIdentityIds`,
      );
  }
  for (const [index, room] of manifest.data.rooms.entries()) {
    for (const identityId of room.participantIdentityIds) {
      requireId(
        identities,
        identityId,
        `$.data.rooms[${index}].participantIdentityIds`,
      );
    }
    if (room.connectorAccountId) {
      requireId(
        connectors,
        room.connectorAccountId,
        `$.data.rooms[${index}].connectorAccountId`,
      );
    }
  }
  for (const [index, message] of manifest.data.messages.entries()) {
    requireId(rooms, message.roomId, `$.data.messages[${index}].roomId`);
    requireId(
      identities,
      message.senderIdentityId,
      `$.data.messages[${index}].senderIdentityId`,
    );
    if (message.threadId)
      requireId(
        threads,
        message.threadId,
        `$.data.messages[${index}].threadId`,
      );
    if (message.replyToMessageId)
      requireId(
        messages,
        message.replyToMessageId,
        `$.data.messages[${index}].replyToMessageId`,
      );
    for (const mediaId of message.mediaIds ?? [])
      requireId(media, mediaId, `$.data.messages[${index}].mediaIds`);
  }
  for (const [index, thread] of manifest.data.threads.entries()) {
    requireId(rooms, thread.roomId, `$.data.threads[${index}].roomId`);
    for (const identityId of thread.participantIdentityIds ?? [])
      requireId(
        identities,
        identityId,
        `$.data.threads[${index}].participantIdentityIds`,
      );
  }
  for (const [index, grant] of manifest.data.grants.entries())
    requireId(
      identities,
      grant.subjectIdentityId,
      `$.data.grants[${index}].subjectIdentityId`,
    );
  for (const [index, connector] of manifest.data.connectorAccounts.entries()) {
    requireId(
      identities,
      connector.ownerIdentityId,
      `$.data.connectorAccounts[${index}].ownerIdentityId`,
    );
    for (const grantId of connector.grantIds) {
      requireId(grants, grantId, `$.data.connectorAccounts[${index}].grantIds`);
    }
  }
  for (const [index, calendar] of manifest.data.calendars.entries()) {
    requireId(
      identities,
      calendar.ownerIdentityId,
      `$.data.calendars[${index}].ownerIdentityId`,
    );
  }
  for (const [index, event] of manifest.data.calendarEvents.entries()) {
    requireId(
      calendars,
      event.calendarId,
      `$.data.calendarEvents[${index}].calendarId`,
    );
    if (Date.parse(event.endsAt) < Date.parse(event.startsAt)) {
      findings.push(
        `$.data.calendarEvents[${index}]: endsAt precedes startsAt`,
      );
    }
    for (const identityId of event.attendeeIdentityIds)
      requireId(
        identities,
        identityId,
        `$.data.calendarEvents[${index}].attendeeIdentityIds`,
      );
  }
  for (const [index, task] of manifest.data.tasks.entries())
    requireId(
      identities,
      task.ownerIdentityId,
      `$.data.tasks[${index}].ownerIdentityId`,
    );
  for (const [index, reminder] of manifest.data.reminders.entries()) {
    requireId(
      identities,
      reminder.ownerIdentityId,
      `$.data.reminders[${index}].ownerIdentityId`,
    );
    if (reminder.taskId)
      requireId(tasks, reminder.taskId, `$.data.reminders[${index}].taskId`);
  }
  for (const [index, memory] of manifest.data.memories.entries()) {
    requireId(agents, memory.agentId, `$.data.memories[${index}].agentId`);
    if (memory.roomId)
      requireId(rooms, memory.roomId, `$.data.memories[${index}].roomId`);
  }
  for (const [index, contact] of manifest.data.contacts.entries()) {
    requireId(
      identities,
      contact.ownerIdentityId,
      `$.data.contacts[${index}].ownerIdentityId`,
    );
    requireId(
      identities,
      contact.identityId,
      `$.data.contacts[${index}].identityId`,
    );
  }
  for (const [index, relationship] of manifest.data.relationships.entries()) {
    requireId(
      identities,
      relationship.fromIdentityId,
      `$.data.relationships[${index}].fromIdentityId`,
    );
    requireId(
      identities,
      relationship.toIdentityId,
      `$.data.relationships[${index}].toIdentityId`,
    );
  }
  for (const [index, approval] of manifest.data.approvals.entries()) {
    requireId(
      identities,
      approval.requesterIdentityId,
      `$.data.approvals[${index}].requesterIdentityId`,
    );
    requireId(
      identities,
      approval.approverIdentityId,
      `$.data.approvals[${index}].approverIdentityId`,
    );
  }
  for (const [index, notification] of manifest.data.notifications.entries())
    requireId(
      identities,
      notification.recipientIdentityId,
      `$.data.notifications[${index}].recipientIdentityId`,
    );
  for (const [index, account] of manifest.data.billingAccounts.entries())
    requireId(
      identities,
      account.ownerIdentityId,
      `$.data.billingAccounts[${index}].ownerIdentityId`,
    );
  for (const [
    index,
    transaction,
  ] of manifest.data.billingTransactions.entries()) {
    requireId(
      accounts,
      transaction.accountId,
      `$.data.billingTransactions[${index}].accountId`,
    );
  }

  const boundaries = new Set<string>();
  for (const [index, script] of manifest.faults.entries()) {
    if (boundaries.has(script.boundary))
      findings.push(
        `$.faults[${index}]: duplicate boundary ${script.boundary}`,
      );
    boundaries.add(script.boundary);
    const attempts = new Set<number>();
    for (const step of script.steps) {
      if (attempts.has(step.onAttempt))
        findings.push(
          `$.faults[${index}]: duplicate attempt ${step.onAttempt}`,
        );
      attempts.add(step.onAttempt);
    }
  }
}

export function parseWorldManifest(input: unknown): WorldManifest {
  const manifest = worldManifestSchema.parse(input);
  const findings: string[] = [];
  inspectFixtureValue(
    manifest as unknown as JsonValue,
    "$",
    manifest.fixturePolicy,
    findings,
  );
  validateReferences(manifest, findings);
  if (findings.length > 0) throw new UnsafeFixtureError(findings);
  return manifest;
}

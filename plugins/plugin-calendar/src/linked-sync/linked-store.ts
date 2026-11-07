/**
 * Durable owner/source-bound checkpoints for explicit local-first Google
 * Calendar sync on a phone or browser client. Provider effects stay in the
 * shared `LinkedCalendarReconciler`; this store only persists checkpoints
 * through the host's compare-and-exchange storage (encrypted on a phone).
 *
 * Browser-safe: Web Crypto only, no Node built-ins.
 */
import type {
  LinkedCalendarCheckpointStore,
  LinkedCalendarEventRecord,
} from "@elizaos/contracts";

/** The exact account, calendar, agent and local source a sync is bound to. */
export type CalendarSyncBinding = {
  environment: "production" | "staging";
  userId: string;
  organizationId: string;
  connectionId: string;
  providerAccountId: string;
  calendarId: string;
  agentId: string;
  localSourceId: string;
  localSourceRevision: string;
};

export interface CalendarLinkStorage {
  read(slot: string): Promise<unknown | null>;
  compareExchange(
    slot: string,
    expected: unknown | null,
    value: unknown,
  ): Promise<{ status: "saved" | "conflict" }>;
}

export interface CalendarLinkedStoreOptions {
  /**
   * Prefix of each link's provider idempotency key. Existing installs keep
   * their prefix: keys are never rewritten, so a reconnect cannot create a
   * second Google event for an already linked local event.
   */
  idempotencyNamespace?: string;
}

/** Storage slot prefix of one binding's checkpoint document. */
export const CALENDAR_LINK_SLOT_PREFIX = "calendar-linked-sync:v1:";
/** Most local events one binding may link. */
export const CALENDAR_LINK_LIMIT = 2000;
/** Largest checkpoint document, as JSON bytes. */
export const CALENDAR_LINK_DOCUMENT_BYTES = 4 * 1024 * 1024;

type Link = LinkedCalendarEventRecord<string>;
type Document = { version: 1; owner: string; links: Link[] };

const BINDING_FIELDS = [
  "environment",
  "userId",
  "organizationId",
  "connectionId",
  "providerAccountId",
  "calendarId",
  "agentId",
  "localSourceId",
  "localSourceRevision",
] as const;
const LINK_FIELDS = [
  "id",
  "agentId",
  "localEventId",
  "connectorAccountId",
  "providerCalendarId",
  "providerEventId",
  "providerEtag",
  "localRevision",
  "lastCommonSemanticHash",
  "state",
  "pendingOperation",
  "idempotencyKey",
  "lastErrorCode",
  "lastErrorMessage",
  "createdAt",
  "updatedAt",
]
  .sort()
  .join();
const PATCH_FIELDS: readonly string[] = [
  "providerEventId",
  "providerEtag",
  "localRevision",
  "lastCommonSemanticHash",
  "state",
  "pendingOperation",
  "lastErrorCode",
  "lastErrorMessage",
];
const STATES: readonly string[] = [
  "clean",
  "dirty",
  "conflicted",
  "quarantined",
  "paused",
  "local_only",
];

const text = (value: unknown, max = 1024): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: identifiers never carry control characters.
  !/[\u0000-\u001f\u007f]/.test(value);
const nullable = (value: unknown, max = 1024) =>
  value === null || text(value, max);
const errorText = (value: unknown) =>
  value === null || (typeof value === "string" && value.length <= 4096);
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const refuse = () =>
  Error(
    "Calendar sync checkpoints changed or need recovery. Existing data is retained.",
  );

async function hash(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class CalendarLinkedStore
  implements LinkedCalendarCheckpointStore<string>
{
  readonly scope: string;
  private readonly sourceScope: string;
  private readonly binding: CalendarSyncBinding;
  private readonly current: () => boolean;
  private readonly storage: CalendarLinkStorage;
  private readonly namespace: string;

  // Explicit fields (no parameter properties) keep this module erasable for type-stripping hosts.
  private constructor(
    scope: string,
    sourceScope: string,
    binding: CalendarSyncBinding,
    current: () => boolean,
    storage: CalendarLinkStorage,
    namespace: string,
  ) {
    this.scope = scope;
    this.sourceScope = sourceScope;
    this.binding = binding;
    this.current = current;
    this.storage = storage;
    this.namespace = namespace;
  }

  static async open(
    binding: CalendarSyncBinding,
    current: () => boolean,
    storage: CalendarLinkStorage,
    options: CalendarLinkedStoreOptions = {},
  ): Promise<CalendarLinkedStore> {
    binding = { ...binding };
    const namespace = options.idempotencyNamespace ?? "calendar-sync";
    if (!text(namespace, 64) || namespace.includes(":")) throw refuse();
    if (
      !["production", "staging"].includes(binding.environment) ||
      Object.keys(binding).sort().join() !==
        [...BINDING_FIELDS].sort().join() ||
      Object.values(binding).some((value) => !text(value))
    )
      throw refuse();
    const identity = BINDING_FIELDS.map((key) => binding[key]);
    const [scope, sourceScope] = await Promise.all([
      hash(identity),
      hash([
        binding.environment,
        binding.localSourceId,
        binding.localSourceRevision,
      ]),
    ]);
    const store = new CalendarLinkedStore(
      scope,
      sourceScope,
      { ...binding },
      current,
      storage,
      namespace,
    );
    store.check();
    await store.read();
    return store;
  }

  private slot() {
    return CALENDAR_LINK_SLOT_PREFIX + this.scope;
  }

  private check() {
    if (!this.current())
      throw new DOMException("Calendar sync connection changed", "AbortError");
  }

  private validateLink(value: unknown): Link {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw refuse();
    const link = value as Link;
    if (
      Object.keys(link).sort().join() !== LINK_FIELDS ||
      !text(link.id) ||
      !text(link.localEventId) ||
      link.agentId !== this.binding.agentId ||
      link.connectorAccountId !== this.binding.connectionId ||
      link.providerCalendarId !== this.binding.calendarId ||
      !text(link.localRevision) ||
      !nullable(link.providerEventId) ||
      !nullable(link.providerEtag) ||
      !nullable(link.lastErrorCode) ||
      !errorText(link.lastErrorMessage) ||
      !STATES.includes(link.state) ||
      !["create", "update", "delete", null].includes(link.pendingOperation) ||
      (link.lastCommonSemanticHash !== null &&
        !/^[a-f0-9]{64}$/.test(link.lastCommonSemanticHash)) ||
      // Existing checkpoint keys are never rewritten; new links remain stable
      // across a Google reconnect while checkpoints stay account-isolated.
      ![
        `${this.namespace}:${this.sourceScope}:${link.localEventId}`,
        `${this.namespace}:${this.scope}:${link.id}`,
      ].includes(link.idempotencyKey) ||
      !timestamp(link.createdAt) ||
      !timestamp(link.updatedAt)
    )
      throw refuse();
    return link;
  }

  private async read(): Promise<Document | null> {
    this.check();
    const value = await this.storage.read(this.slot());
    this.check();
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw refuse();
    const document = value as Document;
    if (
      Object.keys(document).sort().join() !== "links,owner,version" ||
      document.version !== 1 ||
      document.owner !== this.scope ||
      !Array.isArray(document.links) ||
      document.links.length > CALENDAR_LINK_LIMIT ||
      new TextEncoder().encode(JSON.stringify(document)).length >
        CALENDAR_LINK_DOCUMENT_BYTES
    )
      throw refuse();
    const ids = new Set<string>(),
      events = new Set<string>();
    for (const row of document.links) {
      const link = this.validateLink(row);
      if (ids.has(link.id) || events.has(link.localEventId)) throw refuse();
      ids.add(link.id);
      events.add(link.localEventId);
    }
    return structuredClone(document);
  }

  async list(): Promise<Link[]> {
    return (await this.read())?.links || [];
  }

  async link(localEventId: string, localRevision: string): Promise<Link> {
    if (!text(localEventId) || !text(localRevision)) throw refuse();
    const before = await this.read(),
      existing = before?.links.find((row) => row.localEventId === localEventId);
    if (existing) return existing;
    if ((before?.links.length || 0) >= CALENDAR_LINK_LIMIT) throw refuse();
    const now = new Date().toISOString(),
      id = crypto.randomUUID();
    const row: Link = {
      id,
      agentId: this.binding.agentId,
      localEventId,
      connectorAccountId: this.binding.connectionId,
      providerCalendarId: this.binding.calendarId,
      providerEventId: null,
      providerEtag: null,
      localRevision,
      lastCommonSemanticHash: null,
      state: "dirty",
      pendingOperation: "create",
      idempotencyKey: `${this.namespace}:${this.sourceScope}:${localEventId}`,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    const next: Document = {
      version: 1,
      owner: this.scope,
      links: [...(before?.links || []), row],
    };
    this.check();
    const result = await this.storage.compareExchange(
      this.slot(),
      before,
      next,
    );
    this.check();
    if (result.status !== "saved") {
      const concurrent = (await this.read())?.links.find(
        (link) => link.localEventId === localEventId,
      );
      if (concurrent) return concurrent;
      throw refuse();
    }
    return structuredClone(row);
  }

  async save(
    expected: Link,
    patch: Partial<Omit<Link, "id" | "agentId" | "localEventId" | "createdAt">>,
    now = new Date(),
  ): Promise<Link> {
    expected = structuredClone(this.validateLink(expected));
    patch = structuredClone(patch);
    if (Object.keys(patch).some((key) => !PATCH_FIELDS.includes(key)))
      throw refuse();
    const before = await this.read(),
      actual = before?.links.find((row) => row.id === expected.id);
    if (!before || JSON.stringify(actual) !== JSON.stringify(expected))
      throw refuse();
    const next = {
      ...expected,
      ...patch,
      updatedAt: new Date(
        Math.max(now.getTime(), Date.parse(expected.updatedAt) + 1),
      ).toISOString(),
    };
    this.validateLink(next);
    const document: Document = {
      ...before,
      links: before.links.map((row) => (row.id === expected.id ? next : row)),
    };
    this.check();
    if (
      (await this.storage.compareExchange(this.slot(), before, document))
        .status !== "saved"
    )
      throw refuse();
    this.check();
    return structuredClone(next);
  }
}

/**
 * Nostr service implementation for ElizaOS.
 */

import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Service,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { type Event, finalizeEvent, getPublicKey, SimplePool, verifyEvent } from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import {
  normalizeNostrAccountId,
  readNostrAccountId,
  resolveDefaultNostrAccountId,
  resolveNostrAccountSettings,
} from "./accounts.js";
import {
  type INostrService,
  NOSTR_SERVICE_NAME,
  NostrConfigurationError,
  type NostrDmSendOptions,
  NostrEventTypes,
  type NostrProfile,
  type NostrSendResult,
  type NostrSettings,
  normalizePubkey,
  pubkeyToNpub,
  splitMessageForNostr,
  validatePrivateKey,
} from "./types.js";

const NOSTR_CONNECTOR_CONTEXTS = ["social", "connectors"];
const NOSTR_CONNECTOR_CAPABILITIES = [
  "send_message",
  "fetch_messages",
  "resolve_targets",
  "user_context",
];

type NostrMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] & {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params?: { target?: TargetInfo; limit?: number; before?: string; after?: string }
  ) => Promise<Memory[]>;
  contentShaping?: {
    systemPromptFragment?: string;
    constraints?: Record<string, unknown>;
  };
};

interface PostConnectorQueryContext {
  runtime: IAgentRuntime;
  roomId?: UUID;
  source?: string;
  target?: TargetInfo;
  metadata?: Record<string, unknown>;
}

interface PostConnectorRegistration {
  source: string;
  label?: string;
  description?: string;
  capabilities?: string[];
  contexts?: string[];
  metadata?: Record<string, unknown>;
  postHandler: (runtime: IAgentRuntime, content: Content) => Promise<Memory>;
  fetchFeed?: (
    context: PostConnectorQueryContext,
    params?: { feed?: string; target?: TargetInfo; limit?: number; cursor?: string }
  ) => Promise<Memory[]>;
  searchPosts?: (
    context: PostConnectorQueryContext,
    params: { query: string; limit?: number; cursor?: string }
  ) => Promise<Memory[]>;
  contentShaping?: {
    systemPromptFragment?: string;
    constraints?: Record<string, unknown>;
  };
}

type RuntimeWithPostConnector = IAgentRuntime & {
  registerPostConnector?: (registration: PostConnectorRegistration) => void;
};

function getNostrTargetMetadata(target: TargetInfo): Record<string, unknown> | undefined {
  const metadata = (target as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(1, Math.floor(value as number)), max);
}

export class NostrService extends Service implements INostrService {
  static serviceType = NOSTR_SERVICE_NAME;
  capabilityDescription = "Provides Nostr protocol integration for encrypted direct messages";

  private settings: NostrSettings | null = null;
  private pool: SimplePool | null = null;
  private privateKey: Uint8Array | null = null;
  private connected = false;
  private seenEventIds = new Set<string>();

  /**
   * Start the Nostr service.
   */
  static async start(runtime: IAgentRuntime): Promise<NostrService> {
    logger.info("Starting Nostr service...");
    const service = new NostrService(runtime);
    await service.initialize();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: NostrService): void {
    if (!serviceInstance) {
      return;
    }

    const accountId = serviceInstance.getAccountId(runtime);
    serviceInstance.registerPostConnector(runtime);

    const sendHandler = serviceInstance.handleSendMessage.bind(serviceInstance);
    if (typeof runtime.registerMessageConnector === "function") {
      const registration: NostrMessageConnectorRegistration = {
        source: "nostr",
        accountId,
        label: "Nostr",
        description: "Nostr encrypted DM connector using NIP-04.",
        capabilities: [...NOSTR_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["user", "contact"],
        contexts: [...NOSTR_CONNECTOR_CONTEXTS],
        metadata: {
          accountId,
          service: NOSTR_SERVICE_NAME,
        },
        resolveTargets: serviceInstance.resolveConnectorTargets.bind(serviceInstance),
        listRecentTargets: serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
        getUserContext: serviceInstance.getConnectorUserContext.bind(serviceInstance),
        fetchMessages: serviceInstance.fetchConnectorMessages.bind(serviceInstance),
        contentShaping: {
          systemPromptFragment:
            "For Nostr encrypted DMs, keep messages concise. Long messages may be split by the connector for relay delivery.",
          constraints: {
            supportsMarkdown: false,
            channelType: ChannelType.DM,
          },
        },
        sendHandler,
      };
      runtime.registerMessageConnector(registration);
      runtime.logger.info(
        { src: "plugin:nostr", agentId: runtime.agentId },
        "Registered Nostr DM connector"
      );
      return;
    }

    runtime.registerSendHandler("nostr", sendHandler);
  }

  private registerPostConnector(runtime: IAgentRuntime): void {
    const withPostConnector = runtime as RuntimeWithPostConnector;
    if (typeof withPostConnector.registerPostConnector !== "function") {
      return;
    }
    const accountId = this.getAccountId(runtime);

    withPostConnector.registerPostConnector({
      source: "nostr",
      accountId,
      label: "Nostr",
      description:
        "Nostr public note connector for publishing kind:1 notes, reading relay feeds, and NIP-50 relay search where supported.",
      capabilities: ["post", "fetch_feed", "search_posts"],
      contexts: ["social", "social_posting", "connectors"],
      metadata: {
        accountId,
        service: NOSTR_SERVICE_NAME,
      },
      postHandler: this.handleSendPost.bind(this),
      fetchFeed: this.fetchConnectorFeed.bind(this),
      searchPosts: this.searchConnectorPosts.bind(this),
      contentShaping: {
        systemPromptFragment:
          "For Nostr notes, write plain public text. Hashtags and nostr: references are acceptable when useful; avoid Markdown-specific formatting.",
        constraints: {
          supportsMarkdown: false,
          channelType: ChannelType.FEED,
        },
      },
    });

    runtime.logger.info(
      { src: "plugin:nostr", agentId: runtime.agentId },
      "Registered Nostr post connector"
    );
  }

  /**
   * Initialize the service.
   */
  private async initialize(): Promise<void> {
    this.settings = this.loadSettings();
    this.validateSettings();

    // Initialize private key
    this.privateKey = validatePrivateKey(this.settings.privateKey);

    // Initialize SimplePool
    this.pool = new SimplePool();

    // Start subscription
    await this.startSubscription();

    this.connected = true;
    logger.info(`Nostr service started (pubkey: ${this.settings.publicKey.slice(0, 16)}...)`);
    this.runtime.emitEvent(NostrEventTypes.CONNECTION_READY, {
      runtime: this.runtime,
      service: this,
      accountId: this.getAccountId(),
    } as EventPayload);
  }

  /**
   * Stop the Nostr service.
   */
  async stop(): Promise<void> {
    logger.info("Stopping Nostr service...");
    this.connected = false;

    if (this.pool) {
      this.pool.close(this.settings?.relays || []);
      this.pool = null;
    }

    this.privateKey = null;
    this.seenEventIds.clear();
    logger.info("Nostr service stopped");
  }

  /**
   * Load settings from runtime configuration.
   */
  private loadSettings(): NostrSettings {
    const runtime = this.runtime;
    if (!runtime) {
      throw new NostrConfigurationError("Runtime not initialized");
    }

    const resolved = resolveNostrAccountSettings(runtime);
    const allowFrom = resolved.allowFrom.map((p: string) => {
      try {
        return normalizePubkey(p.trim());
      } catch {
        return p.trim();
      }
    });

    // Derive public key
    let publicKey = "";
    if (resolved.privateKey) {
      try {
        const sk = validatePrivateKey(resolved.privateKey);
        publicKey = getPublicKey(sk);
      } catch {
        // Will be caught in validation
      }
    }

    return {
      ...resolved,
      publicKey,
      allowFrom,
    };
  }

  /**
   * Validate the settings.
   */
  private validateSettings(): void {
    const settings = this.settings;
    if (!settings) {
      throw new NostrConfigurationError("Settings not loaded");
    }

    if (!settings.privateKey) {
      throw new NostrConfigurationError("NOSTR_PRIVATE_KEY is required", "NOSTR_PRIVATE_KEY");
    }

    if (!settings.publicKey) {
      throw new NostrConfigurationError(
        "Invalid private key - could not derive public key",
        "NOSTR_PRIVATE_KEY"
      );
    }

    if (settings.relays.length === 0) {
      throw new NostrConfigurationError("At least one relay is required", "NOSTR_RELAYS");
    }

    // Validate relay URLs
    for (const relay of settings.relays) {
      if (!relay.startsWith("wss://") && !relay.startsWith("ws://")) {
        throw new NostrConfigurationError(`Invalid relay URL: ${relay}`, "NOSTR_RELAYS");
      }
    }
  }

  /**
   * Start the DM subscription.
   */
  private async startSubscription(): Promise<void> {
    const settings = this.settings;
    const pool = this.pool;
    const privateKey = this.privateKey;

    if (!settings || !pool || !privateKey) {
      throw new NostrConfigurationError("Service not properly initialized");
    }

    const pk = settings.publicKey;
    const since = Math.floor(Date.now() / 1000) - 120; // Last 2 minutes

    // Subscribe to DMs (kind:4)
    const filter = { kinds: [4], "#p": [pk], since };
    pool.subscribeMany(
      settings.relays,
      [filter] as unknown as Parameters<typeof pool.subscribeMany>[1],
      {
        onevent: async (event: Event) => {
          await this.handleEvent(event);
        },
        oneose: () => {
          logger.debug("Nostr EOSE received - initial sync complete");
        },
      }
    );

    logger.info(`Subscribed to ${settings.relays.length} relay(s)`);
  }

  /**
   * Handle an incoming event.
   */
  private async handleEvent(event: Event): Promise<void> {
    const settings = this.settings;
    const privateKey = this.privateKey;

    if (!settings || !privateKey) {
      return;
    }

    // Dedupe
    if (this.seenEventIds.has(event.id)) {
      return;
    }
    this.seenEventIds.add(event.id);

    // Limit seen set size
    if (this.seenEventIds.size > 10000) {
      const toDelete = Array.from(this.seenEventIds).slice(0, 5000);
      for (const id of toDelete) {
        this.seenEventIds.delete(id);
      }
    }

    // Skip self-messages
    if (event.pubkey === settings.publicKey) {
      return;
    }

    // Verify signature
    if (!verifyEvent(event)) {
      logger.warn(`Invalid signature on event ${event.id}`);
      return;
    }

    // Check if this is addressed to us
    const isToUs = event.tags.some((t) => t[0] === "p" && t[1] === settings.publicKey);
    if (!isToUs) {
      return;
    }

    // Check DM policy
    if (settings.dmPolicy === "disabled") {
      logger.debug(`DM from ${event.pubkey} blocked - DMs disabled`);
      return;
    }

    if (settings.dmPolicy === "allowlist") {
      const allowed = settings.allowFrom.includes(event.pubkey);
      if (!allowed) {
        logger.debug(`DM from ${event.pubkey} blocked - not in allowlist`);
        return;
      }
    }

    // Decrypt the message (NIP-04)
    let plaintext: string;
    try {
      logger.debug(
        { src: "plugin:nostr", op: "nip04:decrypt", from: event.pubkey },
        "Decrypting Nostr DM"
      );
      plaintext = decrypt(privateKey, event.pubkey, event.content);
    } catch (err) {
      logger.warn(
        { src: "plugin:nostr", op: "nip04:decrypt", from: event.pubkey, err: String(err) },
        "Failed to decrypt Nostr DM"
      );
      return;
    }

    logger.debug(`Received DM from ${event.pubkey.slice(0, 8)}...: ${plaintext.slice(0, 50)}...`);

    // Emit event
    if (this.runtime) {
      this.runtime.emitEvent(NostrEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        from: event.pubkey,
        text: plaintext,
        eventId: event.id,
        createdAt: event.created_at,
      } as EventPayload);
    }
  }

  /**
   * Check if the service is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the bot's public key in hex format.
   */
  getPublicKey(): string {
    return this.settings?.publicKey || "";
  }

  getAccountId(runtime?: IAgentRuntime): string {
    return normalizeNostrAccountId(
      this.settings?.accountId ?? (runtime ? resolveDefaultNostrAccountId(runtime) : undefined)
    );
  }

  /**
   * Get the bot's public key in npub format.
   */
  getNpub(): string {
    const pk = this.getPublicKey();
    return pk ? pubkeyToNpub(pk) : "";
  }

  /**
   * Get connected relays.
   */
  getRelays(): string[] {
    return this.settings?.relays || [];
  }

  async handleSendMessage(
    _runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    const requestedAccountId = normalizeNostrAccountId(
      target.accountId ?? readNostrAccountId(content, target) ?? this.getAccountId()
    );
    if (requestedAccountId !== this.getAccountId()) {
      throw new Error(`Nostr account '${requestedAccountId}' is not available in this service instance`);
    }

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("Nostr DM connector requires non-empty text content.");
    }

    const metadata = getNostrTargetMetadata(target);
    const targetPubkey =
      (typeof metadata?.nostrPubkey === "string" ? metadata.nostrPubkey : undefined) ??
      (typeof target.entityId === "string" ? target.entityId : undefined) ??
      target.channelId ??
      target.threadId;

    if (!targetPubkey) {
      throw new Error("Nostr DM connector requires a pubkey target.");
    }

    const chunks = splitMessageForNostr(text);
    for (const chunk of chunks) {
      const result = await this.sendDm({ toPubkey: targetPubkey, text: chunk });
      if (!result.success) {
        throw new Error(result.error ?? "Failed to send Nostr DM");
      }
    }
  }

  async handleSendPost(runtime: IAgentRuntime, content: Content): Promise<Memory> {
    const requestedAccountId = normalizeNostrAccountId(
      readNostrAccountId(content) ?? this.getAccountId()
    );
    if (requestedAccountId !== this.getAccountId()) {
      throw new Error(`Nostr account '${requestedAccountId}' is not available in this service instance`);
    }

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("Nostr post connector requires non-empty text content.");
    }

    const result = await this.publishNote(text);
    if (!result.success || !result.eventId) {
      throw new Error(result.error ?? "Failed to publish Nostr note");
    }

    return this.nostrEventToPostMemory(runtime, {
      id: result.eventId,
      pubkey: this.getPublicKey(),
      kind: 1,
      content: text,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      sig: "",
    } as unknown as Event);
  }

  async fetchConnectorFeed(
    context: PostConnectorQueryContext,
    params: { feed?: string; target?: TargetInfo; limit?: number; cursor?: string } = {}
  ): Promise<Memory[]> {
    const settings = this.settings;
    const pool = this.pool;
    if (!settings || !pool) {
      return [];
    }

    const target = params.target ?? context.target;
    const metadata = target ? getNostrTargetMetadata(target) : undefined;
    const author =
      (typeof metadata?.nostrPubkey === "string" ? metadata.nostrPubkey : undefined) ??
      (typeof target?.entityId === "string" ? target.entityId : undefined);
    const normalizedAuthor = author ? normalizePubkey(author) : undefined;
    const filter = {
      kinds: [1],
      limit: clampLimit(params.limit, 25, 100),
      ...(normalizedAuthor ? { authors: [normalizedAuthor] } : {}),
      ...(params.cursor && Number.isFinite(Number(params.cursor))
        ? { until: Number(params.cursor) }
        : {}),
    } as unknown as Parameters<SimplePool["querySync"]>[1];

    const events = await pool.querySync(settings.relays, filter, { maxWait: 3000 });
    return events
      .sort((a, b) => b.created_at - a.created_at)
      .map((event) => this.nostrEventToPostMemory(context.runtime, event));
  }

  async searchConnectorPosts(
    context: PostConnectorQueryContext,
    params: { query: string; limit?: number; cursor?: string }
  ): Promise<Memory[]> {
    const query = params.query?.trim();
    if (!query) {
      throw new Error("Nostr searchPosts connector requires a query.");
    }

    const settings = this.settings;
    const pool = this.pool;
    if (!settings || !pool) {
      return [];
    }

    const filter = {
      kinds: [1],
      search: query,
      limit: clampLimit(params.limit, 25, 100),
      ...(params.cursor && Number.isFinite(Number(params.cursor))
        ? { until: Number(params.cursor) }
        : {}),
    } as unknown as Parameters<SimplePool["querySync"]>[1];

    const events = await pool.querySync(settings.relays, filter, { maxWait: 3000 });
    return events
      .sort((a, b) => b.created_at - a.created_at)
      .map((event) => this.nostrEventToPostMemory(context.runtime, event));
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: { target?: TargetInfo; limit?: number; before?: string; after?: string } = {}
  ): Promise<Memory[]> {
    const settings = this.settings;
    const pool = this.pool;
    const privateKey = this.privateKey;
    if (!settings || !pool || !privateKey) {
      return [];
    }

    const target = params.target ?? context.target;
    const metadata = target ? getNostrTargetMetadata(target) : undefined;
    const targetPubkeyRaw =
      (typeof metadata?.nostrPubkey === "string" ? metadata.nostrPubkey : undefined) ??
      (typeof target?.entityId === "string" ? target.entityId : undefined);
    const targetPubkey = targetPubkeyRaw ? normalizePubkey(targetPubkeyRaw) : undefined;
    const limit = clampLimit(params.limit, 25, 100);
    const filters = [
      {
        kinds: [4],
        "#p": [settings.publicKey],
        ...(targetPubkey ? { authors: [targetPubkey] } : {}),
        limit,
      },
      ...(targetPubkey
        ? [
            {
              kinds: [4],
              authors: [settings.publicKey],
              "#p": [targetPubkey],
              limit,
            },
          ]
        : []),
    ] as unknown as Parameters<SimplePool["querySync"]>[1][];

    const byId = new Map<string, Event>();
    for (const filter of filters) {
      const events = await pool.querySync(settings.relays, filter, { maxWait: 3000 });
      for (const event of events) {
        byId.set(event.id, event);
      }
    }

    const memories: Memory[] = [];
    for (const event of Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at)) {
      const isOwn = event.pubkey === settings.publicKey;
      const peerPubkey = isOwn ? event.tags.find((tag) => tag[0] === "p")?.[1] : event.pubkey;
      if (!peerPubkey) {
        continue;
      }

      try {
        const plaintext = decrypt(privateKey, peerPubkey, event.content);
        memories.push(this.nostrEventToDmMemory(context.runtime, event, plaintext, peerPubkey));
      } catch (error) {
        logger.debug(
          {
            src: "plugin:nostr",
            op: "fetchConnectorMessages",
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Skipping Nostr DM that could not be decrypted"
        );
      }

      if (memories.length >= limit) {
        break;
      }
    }

    return memories;
  }

  async resolveConnectorTargets(
    query: string,
    _context: MessageConnectorQueryContext
  ): Promise<MessageConnectorTarget[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.listRecentConnectorTargets(_context);
    }

    let pubkey: string;
    try {
      pubkey = normalizePubkey(trimmed);
    } catch {
      return [];
    }

    return [this.buildPubkeyTarget(pubkey, 1)];
  }

  async listRecentConnectorTargets(
    _context: MessageConnectorQueryContext
  ): Promise<MessageConnectorTarget[]> {
    const allowFrom = this.settings?.allowFrom ?? [];
    return allowFrom.map((pubkey, index) => this.buildPubkeyTarget(pubkey, 0.8 - index * 0.01));
  }

  async getConnectorUserContext(
    entityId: string,
    _context: MessageConnectorQueryContext
  ): Promise<MessageConnectorUserContext | null> {
    let pubkey: string;
    try {
      pubkey = normalizePubkey(entityId);
    } catch {
      return null;
    }

    return {
      entityId,
      label: pubkeyToNpub(pubkey),
      aliases: [pubkey, pubkeyToNpub(pubkey)],
      handles: {
        nostr: pubkeyToNpub(pubkey),
      },
      metadata: {
        accountId: this.getAccountId(),
        nostrPubkey: pubkey,
        relays: this.getRelays(),
      },
    };
  }

  private nostrEventToPostMemory(runtime: IAgentRuntime, event: Event): Memory {
    const createdAt = event.created_at ? event.created_at * 1000 : Date.now();
    const entityId =
      event.pubkey === runtime.agentId
        ? runtime.agentId
        : createUniqueUuid(runtime, `nostr:user:${event.pubkey}`);
    const roomId = createUniqueUuid(runtime, `nostr:feed:${event.pubkey}`);

    return {
      id: createUniqueUuid(runtime, `nostr:note:${event.id}`),
      agentId: runtime.agentId,
      entityId,
      roomId,
      createdAt,
      content: {
        text: event.content,
        source: "nostr",
        url: `nostr:${event.id}`,
        channelType: ChannelType.FEED,
      },
      metadata: {
        type: "message",
        source: "nostr",
        accountId: this.getAccountId(runtime),
        provider: "nostr",
        timestamp: createdAt,
        fromBot: event.pubkey === this.getPublicKey(),
        messageIdFull: event.id,
        chatType: ChannelType.FEED,
        sender: {
          id: event.pubkey,
          username: pubkeyToNpub(event.pubkey),
        },
        nostr: {
          accountId: this.getAccountId(runtime),
          eventId: event.id,
          pubkey: event.pubkey,
          npub: pubkeyToNpub(event.pubkey),
          kind: event.kind,
          tags: event.tags,
        },
      } as unknown as Memory["metadata"],
    };
  }

  private nostrEventToDmMemory(
    runtime: IAgentRuntime,
    event: Event,
    plaintext: string,
    peerPubkey: string
  ): Memory {
    const createdAt = event.created_at ? event.created_at * 1000 : Date.now();
    const senderId = event.pubkey;
    const entityId =
      senderId === runtime.agentId
        ? runtime.agentId
        : createUniqueUuid(runtime, `nostr:user:${senderId}`);
    const roomId = createUniqueUuid(runtime, `nostr:dm:${peerPubkey}`);

    return {
      id: createUniqueUuid(runtime, `nostr:dm:${event.id}`),
      agentId: runtime.agentId,
      entityId,
      roomId,
      createdAt,
      content: {
        text: plaintext,
        source: "nostr",
        channelType: ChannelType.DM,
      },
      metadata: {
        type: "message",
        source: "nostr",
        accountId: this.getAccountId(runtime),
        provider: "nostr",
        timestamp: createdAt,
        fromBot: senderId === this.getPublicKey(),
        messageIdFull: event.id,
        chatType: ChannelType.DM,
        sender: {
          id: senderId,
          username: pubkeyToNpub(senderId),
        },
        nostr: {
          accountId: this.getAccountId(runtime),
          eventId: event.id,
          pubkey: senderId,
          npub: pubkeyToNpub(senderId),
          peerPubkey,
          peerNpub: pubkeyToNpub(peerPubkey),
          kind: event.kind,
          tags: event.tags,
        },
      } as unknown as Memory["metadata"],
    };
  }

  private buildPubkeyTarget(pubkey: string, score: number): MessageConnectorTarget {
    return {
      target: {
        source: "nostr",
        accountId: this.getAccountId(),
        entityId: pubkey,
      } as TargetInfo,
      label: pubkeyToNpub(pubkey),
      kind: "user",
      description: "Nostr encrypted DM recipient",
      score,
      contexts: [...NOSTR_CONNECTOR_CONTEXTS],
      metadata: {
        accountId: this.getAccountId(),
        nostrPubkey: pubkey,
      },
    };
  }

  /**
   * Send a DM to a pubkey.
   */
  async sendDm(options: NostrDmSendOptions): Promise<NostrSendResult> {
    const settings = this.settings;
    const pool = this.pool;
    const privateKey = this.privateKey;

    if (!settings || !pool || !privateKey) {
      return {
        success: false,
        error: "Service not initialized",
      };
    }

    // Normalize the target pubkey
    let toPubkey: string;
    try {
      toPubkey = normalizePubkey(options.toPubkey);
    } catch (err) {
      return {
        success: false,
        error: `Invalid target pubkey: ${err}`,
      };
    }

    // Encrypt the message (NIP-04)
    let ciphertext: string;
    try {
      logger.debug(
        { src: "plugin:nostr", op: "nip04:encrypt", to: toPubkey },
        "Encrypting Nostr DM"
      );
      ciphertext = encrypt(privateKey, toPubkey, options.text);
    } catch (err) {
      return {
        success: false,
        error: `Encryption failed: ${err}`,
      };
    }

    // Create the event
    const event = finalizeEvent(
      {
        kind: 4,
        content: ciphertext,
        tags: [["p", toPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      privateKey
    );

    // Publish to relays
    const successRelays: string[] = [];
    const errors: string[] = [];

    for (const relay of settings.relays) {
      try {
        logger.debug(
          { src: "plugin:nostr", op: "pool.publish", kind: 4, relay, eventId: event.id },
          "Publishing Nostr DM event to relay"
        );
        await pool.publish([relay], event);
        successRelays.push(relay);
      } catch (err) {
        errors.push(`${relay}: ${err}`);
      }
    }

    if (successRelays.length === 0) {
      return {
        success: false,
        error: `Failed to publish to any relay: ${errors.join("; ")}`,
      };
    }

    logger.debug(`DM sent to ${toPubkey.slice(0, 8)}... via ${successRelays.length} relay(s)`);

    if (this.runtime) {
      this.runtime.emitEvent(NostrEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        to: toPubkey,
        eventId: event.id,
        relays: successRelays,
      } as EventPayload);
    }

    return {
      success: true,
      eventId: event.id,
      relays: successRelays,
    };
  }

  /**
   * Publish profile (kind:0).
   */
  async publishProfile(profile: NostrProfile): Promise<NostrSendResult> {
    const settings = this.settings;
    const pool = this.pool;
    const privateKey = this.privateKey;

    if (!settings || !pool || !privateKey) {
      return {
        success: false,
        error: "Service not initialized",
      };
    }

    // Build profile content
    const content = JSON.stringify({
      name: profile.name,
      display_name: profile.displayName,
      about: profile.about,
      picture: profile.picture,
      banner: profile.banner,
      nip05: profile.nip05,
      lud16: profile.lud16,
      website: profile.website,
    });

    // Create the event
    const event = finalizeEvent(
      {
        kind: 0,
        content,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      privateKey
    );

    // Publish to relays
    const successRelays: string[] = [];
    const errors: string[] = [];

    for (const relay of settings.relays) {
      try {
        logger.debug(
          { src: "plugin:nostr", op: "pool.publish", kind: 0, relay, eventId: event.id },
          "Publishing Nostr profile event to relay"
        );
        await pool.publish([relay], event);
        successRelays.push(relay);
      } catch (err) {
        errors.push(`${relay}: ${err}`);
      }
    }

    if (successRelays.length === 0) {
      return {
        success: false,
        error: `Failed to publish profile to any relay: ${errors.join("; ")}`,
      };
    }

    logger.info(`Profile published via ${successRelays.length} relay(s)`);

    if (this.runtime) {
      this.runtime.emitEvent(NostrEventTypes.PROFILE_PUBLISHED, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        eventId: event.id,
        relays: successRelays,
      } as EventPayload);
    }

    return {
      success: true,
      eventId: event.id,
      relays: successRelays,
    };
  }

  /**
   * Publish a text note (kind:1).
   */
  async publishNote(text: string, tags: string[][] = []): Promise<NostrSendResult> {
    const settings = this.settings;
    const pool = this.pool;
    const privateKey = this.privateKey;

    if (!settings || !pool || !privateKey) {
      return {
        success: false,
        error: "Service not initialized",
      };
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return {
        success: false,
        error: "Note content cannot be empty",
      };
    }

    const event = finalizeEvent(
      {
        kind: 1,
        content: trimmed,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      privateKey
    );

    const successRelays: string[] = [];
    const errors: string[] = [];

    for (const relay of settings.relays) {
      try {
        logger.debug(
          { src: "plugin:nostr", op: "pool.publish", kind: 1, relay, eventId: event.id },
          "Publishing Nostr note to relay"
        );
        await pool.publish([relay], event);
        successRelays.push(relay);
      } catch (err) {
        errors.push(`${relay}: ${err}`);
      }
    }

    if (successRelays.length === 0) {
      return {
        success: false,
        error: `Failed to publish note to any relay: ${errors.join("; ")}`,
      };
    }

    logger.info(
      { src: "plugin:nostr", op: "publishNote", eventId: event.id, relays: successRelays.length },
      "Nostr note published"
    );

    return {
      success: true,
      eventId: event.id,
      relays: successRelays,
    };
  }

  /**
   * Get the settings.
   */
  getSettings(): NostrSettings | null {
    return this.settings;
  }
}

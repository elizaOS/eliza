/**
 * Nostr service implementation for elizaOS.
 */

import {
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
} from "@elizaos/core";
import {
  type Event,
  finalizeEvent,
  getPublicKey,
  SimplePool,
  verifyEvent,
} from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import {
  DEFAULT_NOSTR_RELAYS,
  type INostrService,
  NOSTR_SERVICE_NAME,
  NostrConfigurationError,
  type NostrDmPolicy,
  type NostrDmSendOptions,
  NostrEventTypes,
  type NostrProfile,
  type NostrSendResult,
  type NostrSettings,
  normalizePubkey,
  pubkeyToNpub,
  validatePrivateKey,
} from "./types.js";

export class NostrService extends Service implements INostrService {
  static serviceType = NOSTR_SERVICE_NAME;
  capabilityDescription =
    "Provides Nostr protocol integration for encrypted direct messages";

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
    logger.info(
      `Nostr service started (pubkey: ${this.settings.publicKey.slice(0, 16)}...)`,
    );
    this.runtime.emitEvent(NostrEventTypes.CONNECTION_READY, {
      runtime: this.runtime,
      service: this,
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

    const privateKeySetting = runtime.getSetting("NOSTR_PRIVATE_KEY");
    const privateKey =
      typeof privateKeySetting === "string"
        ? privateKeySetting
        : process.env.NOSTR_PRIVATE_KEY || "";

    const relaysRawSetting = runtime.getSetting("NOSTR_RELAYS");
    const relaysRaw =
      typeof relaysRawSetting === "string"
        ? relaysRawSetting
        : process.env.NOSTR_RELAYS || "";

    const dmPolicySetting = runtime.getSetting("NOSTR_DM_POLICY");
    const dmPolicy = (
      typeof dmPolicySetting === "string"
        ? dmPolicySetting
        : process.env.NOSTR_DM_POLICY || "pairing"
    ) as NostrDmPolicy;

    const allowFromRawSetting = runtime.getSetting("NOSTR_ALLOW_FROM");
    const allowFromRaw =
      typeof allowFromRawSetting === "string"
        ? allowFromRawSetting
        : process.env.NOSTR_ALLOW_FROM || "";

    const enabledSetting = runtime.getSetting("NOSTR_ENABLED");
    const enabled =
      typeof enabledSetting === "string"
        ? enabledSetting
        : process.env.NOSTR_ENABLED || "true";

    // Parse relays
    const relays = relaysRaw
      ? relaysRaw
          .split(",")
          .map((r: string) => r.trim())
          .filter(Boolean)
      : DEFAULT_NOSTR_RELAYS;

    // Parse allow list
    const allowFrom = allowFromRaw
      ? allowFromRaw
          .split(",")
          .map((p: string) => {
            try {
              return normalizePubkey(p.trim());
            } catch {
              return p.trim();
            }
          })
          .filter(Boolean)
      : [];

    // Derive public key
    let publicKey = "";
    if (privateKey) {
      try {
        const sk = validatePrivateKey(privateKey);
        publicKey = getPublicKey(sk);
      } catch {
        // Will be caught in validation
      }
    }

    return {
      privateKey,
      publicKey,
      relays,
      dmPolicy,
      allowFrom,
      enabled: enabled.toLowerCase() !== "false",
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
      throw new NostrConfigurationError(
        "NOSTR_PRIVATE_KEY is required",
        "NOSTR_PRIVATE_KEY",
      );
    }

    if (!settings.publicKey) {
      throw new NostrConfigurationError(
        "Invalid private key - could not derive public key",
        "NOSTR_PRIVATE_KEY",
      );
    }

    if (settings.relays.length === 0) {
      throw new NostrConfigurationError(
        "At least one relay is required",
        "NOSTR_RELAYS",
      );
    }

    // Validate relay URLs
    for (const relay of settings.relays) {
      if (!relay.startsWith("wss://") && !relay.startsWith("ws://")) {
        throw new NostrConfigurationError(
          `Invalid relay URL: ${relay}`,
          "NOSTR_RELAYS",
        );
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
      },
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
    const isToUs = event.tags.some(
      (t) => t[0] === "p" && t[1] === settings.publicKey,
    );
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

    // Decrypt the message
    let plaintext: string;
    try {
      plaintext = decrypt(privateKey, event.pubkey, event.content);
    } catch (err) {
      logger.warn(`Failed to decrypt DM from ${event.pubkey}: ${err}`);
      return;
    }

    logger.debug(
      `Received DM from ${event.pubkey.slice(0, 8)}...: ${plaintext.slice(0, 50)}...`,
    );

    // Emit event
    if (this.runtime) {
      this.runtime.emitEvent(NostrEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
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

    // Encrypt the message
    let ciphertext: string;
    try {
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
      privateKey,
    );

    // Publish to relays
    const successRelays: string[] = [];
    const errors: string[] = [];

    for (const relay of settings.relays) {
      try {
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

    logger.debug(
      `DM sent to ${toPubkey.slice(0, 8)}... via ${successRelays.length} relay(s)`,
    );

    if (this.runtime) {
      this.runtime.emitEvent(NostrEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
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
      privateKey,
    );

    // Publish to relays
    const successRelays: string[] = [];
    const errors: string[] = [];

    for (const relay of settings.relays) {
      try {
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
   * Get the settings.
   */
  getSettings(): NostrSettings | null {
    return this.settings;
  }
}

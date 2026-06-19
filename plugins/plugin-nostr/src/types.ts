/**
 * Type definitions for the Nostr plugin.
 */

import type { Service } from "@elizaos/core";
import { nip19 } from "nostr-tools";

/** Maximum message length for Nostr DMs */
export const MAX_NOSTR_MESSAGE_LENGTH = 4000;

/** Nostr service name */
export const NOSTR_SERVICE_NAME = "nostr";

/** Default Nostr relays */
export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

/** Event types emitted by the Nostr plugin */
export enum NostrEventTypes {
  MESSAGE_RECEIVED = "NOSTR_MESSAGE_RECEIVED",
  MESSAGE_SENT = "NOSTR_MESSAGE_SENT",
  RELAY_CONNECTED = "NOSTR_RELAY_CONNECTED",
  RELAY_DISCONNECTED = "NOSTR_RELAY_DISCONNECTED",
  PROFILE_PUBLISHED = "NOSTR_PROFILE_PUBLISHED",
  CONNECTION_READY = "NOSTR_CONNECTION_READY",
}

/** DM policy types */
export type NostrDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/** Nostr profile data (kind:0) */
export interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
}

/** Configuration settings for the Nostr plugin */
export interface NostrSettings {
  /** Connector account identifier for this Nostr bot instance */
  accountId?: string;
  /** Private key in hex or nsec format */
  privateKey: string;
  /** Public key (derived from private key) */
  publicKey: string;
  /** List of relay WebSocket URLs */
  relays: string[];
  /** DM policy */
  dmPolicy: NostrDmPolicy;
  /** Allowed pubkeys for DMs */
  allowFrom: string[];
  /** Profile data */
  profile?: NostrProfile;
  /** Whether the plugin is enabled */
  enabled: boolean;
}

/** Nostr event (kind:4 for DMs) */
export interface NostrMessage {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  kind: number;
  tags: string[][];
  sig: string;
}

/** Options for sending a DM */
export interface NostrDmSendOptions {
  /** Target pubkey (hex or npub) */
  toPubkey: string;
  /** Message text */
  text: string;
}

/** Result from sending a DM */
export interface NostrSendResult {
  success: boolean;
  eventId?: string;
  relays?: string[];
  error?: string;
}

/** Nostr service interface */
export interface INostrService extends Service {
  /** Check if the service is connected */
  isConnected(): boolean;

  /** Get the bot's public key in hex format */
  getPublicKey(): string;

  /** Get the bot's public key in npub format */
  getNpub(): string;

  /** Get connected relays */
  getRelays(): string[];

  /** Send a DM to a pubkey */
  sendDm(options: NostrDmSendOptions): Promise<NostrSendResult>;

  /** Publish profile (kind:0) */
  publishProfile(profile: NostrProfile): Promise<NostrSendResult>;

  /** Publish a text note (kind:1) */
  publishNote(text: string, tags?: string[][]): Promise<NostrSendResult>;
}

// Custom error classes

/** Base error class for Nostr plugin errors */
export class NostrPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "NostrPluginError";
  }
}

/** Configuration error */
export class NostrConfigurationError extends NostrPluginError {
  public readonly setting?: string;

  constructor(message: string, setting?: string, cause?: Error) {
    super(message, "CONFIGURATION_ERROR", cause);
    this.name = "NostrConfigurationError";
    this.setting = setting;
  }
}

/** Relay error */
export class NostrRelayError extends NostrPluginError {
  public readonly relay?: string;

  constructor(message: string, relay?: string, cause?: Error) {
    super(message, "RELAY_ERROR", cause);
    this.name = "NostrRelayError";
    this.relay = relay;
  }
}

/** Cryptography error */
export class NostrCryptoError extends NostrPluginError {
  constructor(message: string, cause?: Error) {
    super(message, "CRYPTO_ERROR", cause);
    this.name = "NostrCryptoError";
  }
}

// Utility functions

/** Check if a string is a valid Nostr pubkey (hex or npub) */
export function isValidPubkey(input: string): boolean {
  if (typeof input !== "string") {
    return false;
  }
  const trimmed = input.trim();

  // npub format
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub";
    } catch {
      return false;
    }
  }

  // Hex format
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}

function bytesToHex(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new NostrCryptoError("Decoded key data must be hex or bytes");
  }
  return Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function decodedDataToHex(data: unknown): string {
  if (typeof data === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(data)) {
      throw new NostrCryptoError("Decoded public key must be 64 hex characters");
    }
    return data.toLowerCase();
  }
  if (data instanceof Uint8Array) {
    return bytesToHex(data);
  }
  throw new NostrCryptoError("Decoded public key must be hex or bytes");
}

function decodedDataToBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof data === "string") {
    return hexToBytes(data);
  }
  throw new NostrCryptoError("Decoded private key must be hex or bytes");
}

/** Normalize a pubkey to hex format (accepts npub or hex) */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  // npub format - decode to hex
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new NostrCryptoError("Invalid npub key");
    }
    return decodedDataToHex(decoded.data);
  }

  // Already hex - validate and return lowercase
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new NostrCryptoError("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}

/** Convert a hex pubkey to npub format */
export function pubkeyToNpub(hexPubkey: string): string {
  const normalized = normalizePubkey(hexPubkey);
  return nip19.npubEncode(normalized);
}

/** Validate and normalize a private key (accepts hex or nsec format) */
export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();

  // Handle nsec (bech32) format
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new NostrCryptoError("Invalid nsec key: wrong type");
    }
    return decodedDataToBytes(decoded.data);
  }

  // Handle hex format
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new NostrCryptoError("Private key must be 64 hex characters or nsec bech32 format");
  }

  // Convert hex string to Uint8Array
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Get display name for a pubkey */
export function getPubkeyDisplayName(pubkey: string): string {
  const normalized = normalizePubkey(pubkey);
  return `${normalized.slice(0, 8)}...${normalized.slice(-8)}`;
}

/** Split long text into chunks for Nostr */
export function splitMessageForNostr(
  text: string,
  maxLength: number = MAX_NOSTR_MESSAGE_LENGTH
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = maxLength;
    const newlineIndex = remaining.lastIndexOf("\n", maxLength);
    if (newlineIndex > maxLength * 0.5) {
      breakPoint = newlineIndex + 1;
    } else {
      const spaceIndex = remaining.lastIndexOf(" ", maxLength);
      if (spaceIndex > maxLength * 0.5) {
        breakPoint = spaceIndex + 1;
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Server-side in-memory share store.
 * In production, replace with a database (e.g. Redis, Postgres).
 * Module-level singleton persists for the duration of the Node.js process.
 */

import type { Conversation } from "./types";

export type ShareVisibility = "public" | "unlisted" | "password";
export type ShareExpiry = "1h" | "24h" | "7d" | "30d" | "never";

export interface StoredShare {
  id: string;
  conversationId: string;
  conversation: Conversation;
  visibility: ShareVisibility;
  passwordHash?: string; // bcrypt-style hash; plain comparison used here for simplicity
  expiry: ShareExpiry;
  expiresAt?: number;
  createdAt: number;
}

const EXPIRY_MS: Record<ShareExpiry, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  never: null,
};

// Module-level singleton
const store = new Map<string, StoredShare>();

export function createShare(
  shareId: string,
  params: {
    conversation: Conversation;
    visibility: ShareVisibility;
    password?: string;
    expiry: ShareExpiry;
  }
): StoredShare {
  const expiryMs = EXPIRY_MS[params.expiry];
  const now = Date.now();

  const entry: StoredShare = {
    id: shareId,
    conversationId: params.conversation.id,
    conversation: params.conversation,
    visibility: params.visibility,
    passwordHash: params.password ?? undefined,
    expiry: params.expiry,
    expiresAt: expiryMs !== null ? now + expiryMs : undefined,
    createdAt: now,
  };

  store.set(shareId, entry);
  return entry;
}

export function getShare(shareId: string): StoredShare | null {
  const entry = store.get(shareId);
  if (!entry) return null;

  // Check expiry
  if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
    store.delete(shareId);
    return null;
  }

  return entry;
}

export function verifySharePassword(shareId: string, password: string): boolean {
  const entry = store.get(shareId);
  if (!entry || entry.visibility !== "password") return false;
  return entry.passwordHash === password;
}

export function revokeShare(shareId: string): boolean {
  return store.delete(shareId);
}

export function getSharesByConversation(conversationId: string): StoredShare[] {
  return Array.from(store.values()).filter(
    (s) => s.conversationId === conversationId
  );
}

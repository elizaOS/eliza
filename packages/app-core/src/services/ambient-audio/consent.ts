/**
 * In-memory store of ambient-audio capture consent, keyed by owner id. Tracks
 * grant/revoke and honours per-record expiry: `get` returns null once a record
 * has lapsed, and `require` throws when no active consent exists. This is the
 * gate the capture service consults before it may start or resume listening —
 * capture must never begin without a live (non-expired) consent record.
 */
import type { ConsentRecord } from "./types.ts";

export class AmbientAudioConsentState {
  private records = new Map<string, ConsentRecord>();

  grant(record: ConsentRecord): void {
    if (!record.ownerId) {
      throw new Error("ownerId is required");
    }
    this.records.set(record.ownerId, { ...record });
  }

  revoke(ownerId: string): void {
    this.records.delete(ownerId);
  }

  get(ownerId: string, now = Date.now()): ConsentRecord | null {
    const record = this.records.get(ownerId);
    if (!record) return null;
    if (record.expiresAt !== undefined && record.expiresAt <= now) {
      return null;
    }
    return { ...record };
  }

  require(ownerId: string, now = Date.now()): ConsentRecord {
    const record = this.get(ownerId, now);
    if (!record) {
      throw new Error(
        "ambient audio consent is required before capture starts",
      );
    }
    return record;
  }
}

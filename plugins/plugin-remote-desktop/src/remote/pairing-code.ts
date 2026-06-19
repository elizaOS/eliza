/**
 * 6-digit rolling pairing codes for the remote-control control plane (T9a).
 *
 * Codes are one-time use with a 5-minute TTL. They are held in process memory
 * — the control plane is intended to issue a fresh code on every `startSession`
 * call rather than persist codes across restarts.
 */

import { randomInt } from "node:crypto";

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const PAIRING_CODE_LENGTH = 6;

export interface PairingCodeEntry {
  code: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PairingCodeStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * In-process rolling pairing-code store. Each issuance replaces the previous
 * code for that subject. `consume` both validates and invalidates the code.
 */
export class PairingCodeStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, PairingCodeEntry>();

  constructor(options: PairingCodeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  issue(subject: string): PairingCodeEntry {
    const issuedAt = this.now();
    const entry: PairingCodeEntry = {
      code: generatePairingCode(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    this.entries.set(subject, entry);
    return entry;
  }

  /**
   * Validates and consumes the code for `subject`. Returns true if the code
   * matched and was unexpired. Always removes the entry after a match (one-time
   * use) and after any expiry.
   */
  consume(subject: string, code: string): boolean {
    const entry = this.entries.get(subject);
    if (!entry) return false;

    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(subject);
      return false;
    }
    if (entry.code !== code) {
      return false;
    }
    this.entries.delete(subject);
    return true;
  }

  peek(subject: string): PairingCodeEntry | undefined {
    const entry = this.entries.get(subject);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(subject);
      return undefined;
    }
    return entry;
  }

  clear(subject?: string): void {
    if (subject) {
      this.entries.delete(subject);
    } else {
      this.entries.clear();
    }
  }
}

export function generatePairingCode(): string {
  return randomInt(0, 10 ** PAIRING_CODE_LENGTH)
    .toString()
    .padStart(PAIRING_CODE_LENGTH, "0");
}

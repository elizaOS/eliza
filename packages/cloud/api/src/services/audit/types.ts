/**
 * Audit-event schemas and primitives shared by the dispatcher and downstream audit sinks.
 */

import { z } from "zod";
import { AUDIT_ACTIONS, type AuditAction } from "./actions.js";

export type AuditActorType =
  | "user"
  | "api_key"
  | "service"
  | "system"
  | "agent";

export type AuditResult = "success" | "failure" | "denied";
export type AuditMetadataValue = string | number | boolean | null;

export interface AuditActor {
  type: AuditActorType;
  id: string;
}

export interface AuditResource {
  type: string;
  id: string;
}

export interface AuditEvent {
  event_id: string;
  ts: string;
  actor: AuditActor;
  action: AuditAction;
  result: AuditResult;
  resource: AuditResource | null;
  ip?: string;
  user_agent?: string;
  request_id?: string;
  org_id?: string;
  metadata?: Record<string, AuditMetadataValue>;
}

export const AuditActorSchema = z.object({
  type: z.enum(["user", "api_key", "service", "system", "agent"]),
  id: z.string().min(1).max(256),
});

export const AuditResourceSchema = z.object({
  type: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
});

export const AuditEventSchema = z.object({
  event_id: z.uuid(),
  ts: z.iso.datetime({ offset: true }),
  actor: AuditActorSchema,
  action: z.enum(AUDIT_ACTIONS),
  result: z.enum(["success", "failure", "denied"]),
  resource: AuditResourceSchema.nullable(),
  ip: z.string().max(64).optional(),
  user_agent: z.string().max(512).optional(),
  request_id: z.string().max(128).optional(),
  org_id: z.string().max(128).optional(),
  metadata: z
    .record(
      z.string().min(1).max(128),
      z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]),
    )
    .optional(),
});

/** UUIDv7 — sortable, monotonic-ish, fits the contract. */
export function newEventId(): string {
  // 48-bit millis | 4-bit ver(7) | 12-bit rand | 2-bit variant | 62-bit rand
  const ms = BigInt(Date.now());
  const bytes = new Uint8Array(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  // randomness for the rest
  const rand = new Uint8Array(10);
  // crypto.getRandomValues is available in Node 24
  globalThis.crypto.getRandomValues(rand);
  for (const [i, r] of rand.entries()) {
    if (i === 0) {
      bytes[6] = (0x70 | (r & 0x0f)) & 0xff; // version 7
    } else if (i === 2) {
      bytes[8] = (0x80 | (r & 0x3f)) & 0xff; // variant 10
    } else {
      bytes[6 + i] = r;
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Auth audit emitter.
 *
 * Every sensitive auth action ends up in two places:
 *   1. `auth_audit_events` table via `AuthStore.appendAuditEvent`.
 *   2. JSONL file at `<state>/auth/audit.log`, rotated at 10MB, so the
 *      operator can read history even if pglite is wiped.
 *
 * Both writes happen synchronously from the caller's perspective. If the DB
 * write throws the file write still happens (and vice versa) — the operator
 * notices a divergence rather than losing the event entirely.
 *
 * Token-shaped values (20+ characters of `[A-Za-z0-9_-]`) are redacted in
 * `metadata` before either write, so a misconfigured caller can't smuggle a
 * bearer token into an audit row.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnvRecord } from "@elizaos/shared";
import type { AuthStore } from "../../services/auth-store";
import { resolveElizaStateDir } from "../../services/cloud-jwks-store";

export const AUDIT_LOG_FILENAME = "audit.log";
export const AUDIT_LOG_ROTATE_FILENAME = "audit.log.1";
export const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_REDACTION_RE = /[A-Za-z0-9_-]{20,}/;

export interface AuditEventInput {
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  outcome: "success" | "failure";
  metadata?: Record<string, string | number | boolean>;
}

export interface AuditEmitterOptions {
  store: AuthStore;
  env?: RuntimeEnvRecord;
  now?: () => number;
}

function truncateUserAgent(value: string | null): string | null {
  if (!value) return null;
  return value.length > 200 ? value.slice(0, 200) : value;
}

/**
 * Replace token-shaped runs in `metadata` with the literal `<redacted>` string.
 *
 * Only string values are scanned; numbers and booleans pass through unchanged.
 */
export function redactMetadata(
  metadata: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(metadata)) {
    if (typeof raw !== "string") {
      out[key] = raw;
      continue;
    }
    out[key] = AUDIT_REDACTION_RE.test(raw) ? "<redacted>" : raw;
  }
  return out;
}

export function resolveAuditLogPath(
  env: RuntimeEnvRecord = process.env,
): string {
  return path.join(resolveElizaStateDir(env), "auth", AUDIT_LOG_FILENAME);
}

export function resolveAuditLogRotatedPath(
  env: RuntimeEnvRecord = process.env,
): string {
  return path.join(
    resolveElizaStateDir(env),
    "auth",
    AUDIT_LOG_ROTATE_FILENAME,
  );
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  let size: number;
  try {
    const stat = await fs.stat(filePath);
    size = stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (size < AUDIT_LOG_MAX_BYTES) return;
  const rotated = `${filePath}.1`;
  await fs.rename(filePath, rotated).catch(async (err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

interface JsonLine {
  id: string;
  ts: number;
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  outcome: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

async function appendJsonLine(filePath: string, line: JsonLine): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Append an audit event to the database AND the JSONL log.
 *
 * Both writes are attempted. The first error is rethrown to the caller —
 * an audit-write failure is a real problem and should surface, not be
 * swallowed.
 */
export async function appendAuditEvent(
  input: AuditEventInput,
  options: AuditEmitterOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const id = crypto.randomUUID();
  const safeMetadata = redactMetadata(input.metadata ?? {});
  const userAgent = truncateUserAgent(input.userAgent);

  const filePath = resolveAuditLogPath(env);
  const line: JsonLine = {
    id,
    ts: now,
    actorIdentityId: input.actorIdentityId,
    ip: input.ip,
    userAgent,
    action: input.action,
    outcome: input.outcome,
    metadata: safeMetadata,
  };

  let firstError: unknown = null;
  const fileWrite = appendJsonLine(filePath, line).catch((err) => {
    if (firstError === null) firstError = err;
  });
  const dbWrite = options.store
    .appendAuditEvent({
      id,
      ts: now,
      actorIdentityId: input.actorIdentityId,
      ip: input.ip,
      userAgent,
      action: input.action,
      outcome: input.outcome,
      metadata: safeMetadata,
    })
    .catch((err) => {
      if (firstError === null) firstError = err;
    });

  await Promise.all([fileWrite, dbWrite]);
  if (firstError !== null) throw firstError;
}

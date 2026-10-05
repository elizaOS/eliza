/**
 * Audit dispatcher for validating privileged-action events and fanning them out to sinks.
 */

import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { type AuditAction, isAuditAction } from "./actions.js";
import type { AuditSink } from "./sink.js";
import {
  AUDIT_IP_MAX_LENGTH,
  AUDIT_REQUEST_ID_MAX_LENGTH,
  AUDIT_USER_AGENT_MAX_LENGTH,
  type AuditActor,
  type AuditEvent,
  AuditEventSchema,
  type AuditMetadataValue,
  type AuditResource,
  type AuditResult,
  newEventId,
  nowIso,
} from "./types.js";

/**
 * Per-action-prefix metadata allowlist. Keys not on the matching prefix's
 * list are dropped before fan-out. Use this to keep raw PII out of audit
 * sinks — emit `email_hash` instead of `email`, `ip` instead of geo, etc.
 */
const METADATA_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  "auth.": new Set(["ip", "ua", "email_hash", "method", "provider", "reason"]),
  // Never `code`, `state`, a token, or a client secret — only the identifiers
  // needed to reconstruct which relying party asked for what, and why it failed.
  "oidc.": new Set(["ip", "ua", "client_id", "reason", "scope", "error"]),
  "api_key.": new Set(["key_id", "scopes", "reason", "name"]),
  "secret.": new Set(["secret_id", "key_path", "reason"]),
  "plugin.": new Set([
    "plugin_id",
    "version",
    "grant_id",
    "scopes",
    "reason",
    "surface",
    "target",
    "permission",
  ]),
  "agent.": new Set([
    "agent_id",
    "model",
    "reason",
    "session_id",
    "binary",
    "cwd",
    "transcript_hash",
    "transcript_bytes",
    "sandbox",
  ]),
  "vision.": new Set(["reason", "provider", "session_id", "agent_id"]),
  "payment.": new Set([
    "payment_id",
    "amount_minor",
    "currency",
    "provider",
    "reason",
  ]),
  "redemption.": new Set([
    "redemption_id",
    "amount_minor",
    "currency",
    "reason",
  ]),
  "admin.": new Set(["target_user_id", "policy_id", "reason"]),
  "data.": new Set(["request_id", "subject_id", "scope", "reason", "bytes"]),
  "consent.": new Set(["purpose", "policy_version", "source", "granted"]),
};

function allowlistFor(action: AuditAction): ReadonlySet<string> | undefined {
  for (const prefix of Object.keys(METADATA_ALLOWLIST)) {
    if (action.startsWith(prefix)) return METADATA_ALLOWLIST[prefix];
  }
  return undefined;
}

export function redactMetadata(
  action: AuditAction,
  metadata: Record<string, AuditMetadataValue> | undefined,
): Record<string, AuditMetadataValue> | undefined {
  if (!metadata) return undefined;
  const allow = allowlistFor(action);
  if (!allow) return undefined;
  const out: Record<string, AuditMetadataValue> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (allow.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface EmitInput {
  actor: AuditActor;
  action: string;
  result: AuditResult;
  resource?: AuditResource | null;
  ip?: string;
  user_agent?: string;
  request_id?: string;
  org_id?: string;
  metadata?: Record<string, AuditMetadataValue>;
}

export interface SinkError {
  sink: string;
  error: Error;
}

export interface AuditDispatcherOptions {
  sinks: AuditSink[];
  onSinkError?: (err: SinkError, event: AuditEvent) => void;
}

export class AuditDispatcher {
  private readonly sinks: AuditSink[];
  private readonly onSinkError: (err: SinkError, event: AuditEvent) => void;

  constructor(opts: AuditDispatcherOptions) {
    this.sinks = [...opts.sinks];
    this.onSinkError =
      opts.onSinkError ??
      ((err) => {
        logger.error("[AuditDispatcher] sink delivery failed", {
          sink: err.sink,
          error: err.error.message,
        });
      });
  }

  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
  }

  /**
   * Build, validate, redact, and fan out an event. One sink failure does not
   * prevent delivery to the others. A required sink failure rejects after
   * fan-out; optional sink failures remain observable through `onSinkError`.
   */
  async emit(input: EmitInput): Promise<AuditEvent> {
    const event = this.buildEvent(input);
    await this.deliver(event);
    return event;
  }

  /**
   * Build, validate and redact an event without delivering it. Used when the
   * durable record is written inside a caller's database transaction.
   */
  buildEvent(input: EmitInput): AuditEvent {
    if (!isAuditAction(input.action)) {
      throw new Error(`unknown audit action: ${input.action}`);
    }
    const action = input.action;
    const event: AuditEvent = {
      event_id: newEventId(),
      ts: nowIso(),
      actor: input.actor,
      action,
      result: input.result,
      resource: input.resource ?? null,
      // Client-supplied headers must not make a mandatory audit record
      // unwritable: an oversized IP cannot be an address and is dropped, as is
      // an oversized `X-Request-Id` (a prefix would mis-correlate); the user
      // agent keeps its schema-sized prefix.
      ...(input.ip !== undefined && input.ip.length <= AUDIT_IP_MAX_LENGTH
        ? { ip: input.ip }
        : {}),
      ...(input.user_agent !== undefined
        ? { user_agent: input.user_agent.slice(0, AUDIT_USER_AGENT_MAX_LENGTH) }
        : {}),
      ...(input.request_id !== undefined &&
      input.request_id.length <= AUDIT_REQUEST_ID_MAX_LENGTH
        ? { request_id: input.request_id }
        : {}),
      ...(input.org_id !== undefined ? { org_id: input.org_id } : {}),
    };
    const redacted = redactMetadata(action, input.metadata);
    if (redacted) event.metadata = redacted;

    // Schema-validate as a final guard against drift.
    AuditEventSchema.parse(event);
    return event;
  }

  /**
   * Fan a built event out to every sink except `exclude` (a sink that already
   * persisted it, e.g. inside a transaction). Rejects when a required sink
   * fails, after every sink has had a delivery attempt.
   */
  async deliver(
    event: AuditEvent,
    options: { exclude?: string } = {},
  ): Promise<void> {
    const requiredFailures: SinkError[] = [];
    await Promise.all(
      this.sinks
        .filter((sink) => sink.name !== options.exclude)
        .map(async (sink) => {
          try {
            await sink.emit(event);
          } catch (err) {
            // error-policy:J1 boundary translation — finish fan-out so every
            // sink gets a delivery attempt, then reject if any required sink
            // failed. Optional failures remain explicit through onSinkError.
            const error = err instanceof Error ? err : new Error(String(err));
            this.onSinkError({ sink: sink.name, error }, event);
            if (sink.required !== false) {
              requiredFailures.push({ sink: sink.name, error });
            }
          }
        }),
    );
    if (requiredFailures.length > 0) {
      throw new AggregateError(
        requiredFailures.map((failure) => failure.error),
        `Required audit sink delivery failed: ${requiredFailures.map((failure) => failure.sink).join(", ")}`,
      );
    }
  }
}

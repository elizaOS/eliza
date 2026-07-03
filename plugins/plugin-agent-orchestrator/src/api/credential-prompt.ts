/**
 * In-chat surfacing of a sub-agent credential request (#8907).
 *
 * The credential bridge (`bridge-routes.ts`) already fires the sensitive-request
 * flow (REQUEST_SECRET → owner DM / owner-app), but nothing told the user *in
 * the originating task thread* that a sub-agent is blocked waiting on a secret —
 * on Telegram (no side panels) that is the blocking gap. This module posts a
 * compact prompt to the origin room when a request opens, and a status
 * follow-up when the long-poll resolves, so the user can act without leaving
 * chat.
 *
 * Kept decoupled from the route layer: it only needs the runtime's optional
 * `sendMessageToTarget` and the origin keys the orchestrator stamps on
 * `session.metadata` at spawn time (`roomId`, `source`).
 */

import type { Content, IAgentRuntime, UUID } from "@elizaos/core";
import { logger, MESSAGE_SOURCE_SUB_AGENT } from "@elizaos/core";

type RuntimeWithSendTarget = IAgentRuntime & {
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID; accountId?: string },
    content: Content,
  ) => Promise<unknown>;
};

interface CredentialPromptOrigin {
  roomId?: UUID;
  source: string;
}

const DEFAULT_SOURCE = MESSAGE_SOURCE_SUB_AGENT;

function readOrigin(
  metadata: Record<string, unknown> | undefined,
): CredentialPromptOrigin | null {
  if (!metadata) return null;
  const roomId =
    typeof metadata.roomId === "string" ? (metadata.roomId as UUID) : undefined;
  if (!roomId) return null;
  const source =
    typeof metadata.source === "string" && metadata.source
      ? metadata.source
      : DEFAULT_SOURCE;
  return { roomId, source };
}

/** Build the dashboard credentials link when an app base URL is configured. */
function credentialsLink(runtime: IAgentRuntime): string | undefined {
  const raw =
    runtime.getSetting("ELIZA_APP_URL") ||
    runtime.getSetting("ELIZA_CLOUD_URL");
  const base = typeof raw === "string" && raw ? raw.replace(/\/+$/, "") : "";
  return base ? `${base}/settings?section=credentials` : undefined;
}

function formatKeys(keys: readonly string[]): string {
  return keys.map((k) => `\`${k}\``).join(", ");
}

/**
 * Structured secret-request envelope rendered inline by the dashboard's
 * `SensitiveRequestBlock`. Mirrors the owner-app-inline adapter's envelope and
 * adds `delivery.tunnel` so a submitted value is routed through the credential
 * tunnel (to the blocked child) rather than the agent secret store.
 *
 * SECURITY: carries the form spec + tunnel routing identifiers only. The scoped
 * bearer token and the credential value are NEVER included.
 */
interface CredentialSecretRequestEnvelope {
  requestId: string;
  key: string;
  reason?: string;
  status: "pending";
  expiresAt: string;
  delivery: {
    mode: "inline_owner_app";
    instruction?: string;
    privateRouteRequired: true;
    canCollectValueInCurrentChannel: true;
    tunnel: { credentialScopeId: string; childSessionId: string };
  };
  form: {
    type: "sensitive_request_form";
    kind: "secret";
    mode: "inline_owner_app";
    fields: Array<{
      name: string;
      label: string;
      input: "secret";
      required: true;
    }>;
    submitLabel: string;
    statusOnly: true;
  };
}

function buildCredentialEnvelope(input: {
  credentialKeys: readonly string[];
  credentialScopeId: string;
  childSessionId: string;
  expiresAt: number;
  reason?: string;
  instruction?: string;
}): CredentialSecretRequestEnvelope {
  return {
    requestId: `cred_${input.credentialScopeId}`,
    key: input.credentialKeys[0],
    reason: input.reason,
    status: "pending",
    expiresAt: new Date(input.expiresAt).toISOString(),
    delivery: {
      mode: "inline_owner_app",
      instruction: input.instruction,
      privateRouteRequired: true,
      canCollectValueInCurrentChannel: true,
      tunnel: {
        credentialScopeId: input.credentialScopeId,
        childSessionId: input.childSessionId,
      },
    },
    form: {
      type: "sensitive_request_form",
      kind: "secret",
      mode: "inline_owner_app",
      fields: input.credentialKeys.map((name) => ({
        name,
        label: name,
        input: "secret",
        required: true,
      })),
      submitLabel:
        input.credentialKeys.length === 1
          ? "Provide credential"
          : "Provide credentials",
      statusOnly: true,
    },
  };
}

/**
 * Post a credential request to the origin task thread. When the credential
 * scope identifiers are supplied (the production path) this dispatches the real
 * out-of-band sensitive-request — a `secretRequest` content envelope carrying
 * `delivery.tunnel` — so the dashboard's `SensitiveRequestBlock` renders an
 * inline secure form in the originating thread (AC1). The same message carries
 * a plain-text announcement so text-only connectors (Telegram/Discord DM) still
 * surface the request.
 *
 * Returns true when a message was dispatched. Best-effort: a runtime without
 * `sendMessageToTarget`, or a session with no origin room, is a no-op.
 *
 * SECURITY: the scoped bearer token and the credential value are NEVER placed
 * in `text` or in the `secretRequest` envelope — only the form spec + tunnel
 * routing identifiers.
 */
export async function emitCredentialPrompt(input: {
  runtime: IAgentRuntime;
  metadata: Record<string, unknown> | undefined;
  credentialKeys: readonly string[];
  label?: string;
  /** When present, render the inline tunnel-routed secret form (AC1). */
  credentialScopeId?: string;
  childSessionId?: string;
  /** Scope expiry (epoch ms) — surfaced on the inline form envelope. */
  expiresAt?: number;
}): Promise<boolean> {
  const {
    runtime,
    metadata,
    credentialKeys,
    label,
    credentialScopeId,
    childSessionId,
    expiresAt,
  } = input;
  const origin = readOrigin(metadata);
  const send = (runtime as RuntimeWithSendTarget).sendMessageToTarget;
  if (!origin || typeof send !== "function" || credentialKeys.length === 0) {
    return false;
  }
  const who = label ? `Sub-agent **${label}**` : "A sub-agent";
  const link = credentialsLink(runtime);
  const lines = [
    `🔐 ${who} needs ${
      credentialKeys.length === 1 ? "a credential" : "credentials"
    } to continue: ${formatKeys(credentialKeys)}.`,
  ];
  // Secrets never transit chat text — only point at the secure dashboard when a
  // base URL is configured. With no link we post just the announcement; the
  // owner provides the value out-of-band (the credentials settings surface).
  if (link) {
    lines.push(
      `Provide ${credentialKeys.length === 1 ? "it" : "them"} securely here: ${link}`,
    );
  }
  const reason = `${who.replace(/\*\*/g, "")} needs ${
    credentialKeys.length === 1 ? "this credential" : "these credentials"
  } to continue.`;
  // Render the inline secure form only when the credential scope is known. The
  // form value is captured client-side and tunneled to the child — it is never
  // echoed into chat text.
  const secretRequest =
    credentialScopeId && childSessionId
      ? buildCredentialEnvelope({
          credentialKeys,
          credentialScopeId,
          childSessionId,
          expiresAt: expiresAt ?? Date.now() + 30 * 60 * 1000,
          reason,
          instruction: link
            ? "Provide it securely below or in the dashboard."
            : "Provide it securely below.",
        })
      : undefined;
  // `secretRequest` is the canonical content key the dashboard projector reads
  // to hydrate `ConversationMessage.secretRequest`; `Content` does not type it
  // natively, so attach it at the boundary like the owner-app-inline adapter.
  const content = {
    text: lines.join("\n"),
    source: origin.source,
    ...(secretRequest ? { secretRequest } : {}),
  } as Content & { secretRequest?: CredentialSecretRequestEnvelope };
  try {
    await send.call(
      runtime,
      { source: origin.source, roomId: origin.roomId },
      content,
    );
    return true;
  } catch (error) {
    // Posting the prompt is a non-critical side-effect of the credential
    // bridge; never let a delivery failure break the request itself.
    logger.warn(
      `[credential-prompt] failed to post request prompt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Post a follow-up once a requested credential has been delivered, so the user
 * sees the task is unblocked. Best-effort, same no-op conditions as above.
 */
export async function emitCredentialResolved(input: {
  runtime: IAgentRuntime;
  metadata: Record<string, unknown> | undefined;
  key: string;
  label?: string;
}): Promise<boolean> {
  const { runtime, metadata, key, label } = input;
  const origin = readOrigin(metadata);
  if (
    !origin ||
    typeof (runtime as RuntimeWithSendTarget).sendMessageToTarget !== "function"
  ) {
    return false;
  }
  const who = label ? `**${label}**` : "the sub-agent";
  try {
    await (runtime as RuntimeWithSendTarget).sendMessageToTarget?.(
      { source: origin.source, roomId: origin.roomId },
      {
        text: `✅ Credential \`${key}\` received — resuming ${who}.`,
        source: origin.source,
      },
    );
    return true;
  } catch (error) {
    logger.warn(
      `[credential-prompt] failed to post resolution follow-up: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

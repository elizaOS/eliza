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
import { logger } from "@elizaos/core";

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

const DEFAULT_SOURCE = "sub_agent";

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
 * Post a chat prompt to the origin room announcing the pending credential
 * request. Returns true when a message was dispatched. Best-effort: a runtime
 * without `sendMessageToTarget`, or a session with no origin room, is a no-op.
 */
export async function emitCredentialPrompt(input: {
  runtime: IAgentRuntime;
  metadata: Record<string, unknown> | undefined;
  credentialKeys: readonly string[];
  label?: string;
}): Promise<boolean> {
  const { runtime, metadata, credentialKeys, label } = input;
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
    link
      ? `Provide ${credentialKeys.length === 1 ? "it" : "them"} securely here: ${link}`
      : "Reply here to provide it securely, or open the credentials settings.",
  ];
  try {
    await send(
      { source: origin.source, roomId: origin.roomId },
      { text: lines.join("\n"), source: origin.source },
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
  const send = (runtime as RuntimeWithSendTarget).sendMessageToTarget;
  if (!origin || typeof send !== "function") return false;
  const who = label ? `**${label}**` : "the sub-agent";
  try {
    await send(
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

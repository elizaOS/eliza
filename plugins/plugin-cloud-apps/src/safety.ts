/**
 * Shared safety primitives for the plugin's destructive + paid actions.
 *
 * ── Two-phase confirm (connector-agnostic) ───────────────────────────────────
 * A destructive or paid action NEVER acts on the first ask. On the first turn it
 * returns a confirmation prompt that names the exact target and stores a pending
 * confirmation task. It acts only when a later turn carries the planner's
 * structured `confirm: true` boolean for that pending task. The handler never
 * authorizes money/security/destructive work by matching the user's prose, so
 * non-English confirmations depend on the planner's structured extraction
 * instead of English keyword banks.
 *
 * ── Connector-agnostic CTA (for the paid actions) ────────────────────────────
 * Paid actions that must hand the user off to a browser (withdraw earnings, buy
 * a domain) build a neutral {label,url,kind} object the connector renders
 * however it can (Discord link button, Telegram URL button, in-app card). Money
 * and credentials NEVER transit the connector: the CTA carries only a human
 * label plus an https URL the user opens themselves. {@link buildConnectorCta}
 * is the single seam those actions reuse.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";

/** How a connector should render a call-to-action handed back by an action. */
export type CtaKind = "link" | "button" | "card";

/**
 * A neutral call-to-action a connector renders. Carries ONLY a label + URL —
 * never a token, secret, signed payload, or money amount. The user completes
 * any payment/credential step in the browser the URL opens.
 */
export interface ConnectorCta {
  label: string;
  url: string;
  kind: CtaKind;
}

/** The thing a destructive/paid action is about to act on. */
export interface ConfirmTarget {
  /** Human-facing label, e.g. the app name. */
  name: string;
  /** Stable id, e.g. the app id (matched verbatim when present). */
  id?: string;
  /** Other strings that also identify the target (slug, etc.). */
  aliases?: string[];
}

export type CloudAppConfirmationAction =
  | "BUY_APP_DOMAIN"
  | "DELETE_APP"
  | "REGENERATE_APP_API_KEY"
  | "WITHDRAW_APP_EARNINGS"
  | "BOOK_INFLUENCER";

export const CLOUD_APP_CONFIRM_TAG = "cloud-apps-confirm";

export interface CloudAppConfirmationMetadata {
  roomId: string;
  action: CloudAppConfirmationAction;
  appId: string;
  appName: string;
  appSlug?: string;
  amount?: number;
  /** The exact domain a pending BUY_APP_DOMAIN confirmation is for. */
  domain?: string;
  /**
   * True when the pending BUY_APP_DOMAIN is a recovery retry of a purchase
   * that already charged + registered but failed to attach (the server
   * finishes it without a new charge).
   */
  recovery?: boolean;
  cta?: ConnectorCta;
  intentCreatedAt?: string;
  /**
   * BOOK_INFLUENCER only: the campaign brief for the pending booking. (For that
   * action `appId`/`appName` carry the influencer profile id + display name.)
   */
  brief?: string;
}

export interface PendingCloudAppConfirmation {
  taskId: string;
  metadata: CloudAppConfirmationMetadata;
}

export function readStructuredConfirmation(options?: unknown): boolean | null {
  if (!options || typeof options !== "object") return null;
  const opts = options as Record<string, unknown>;
  // Validated action parameters arrive nested under `options.parameters` on the
  // real planner path (execute-planned-tool-call.ts sets `handlerOptions.parameters
  // = validation.args`); only direct handler calls / scenario `action`-kind turns
  // place them at the top level. Read the nested location first, then fall back.
  const params =
    opts.parameters && typeof opts.parameters === "object"
      ? (opts.parameters as Record<string, unknown>)
      : undefined;
  const value =
    params?.confirm ?? params?.confirmed ?? opts.confirm ?? opts.confirmed;
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

export function confirmationRoomId(
  runtime: IAgentRuntime,
  message: Memory,
): string {
  if (typeof message.roomId === "string" && message.roomId.length > 0) {
    return message.roomId;
  }
  return String(runtime.agentId ?? "cloud-apps-default-room");
}

function isCloudAppConfirmationMetadata(
  metadata: Record<string, unknown> | undefined,
  roomId: string,
  action: CloudAppConfirmationAction,
): metadata is Record<string, unknown> & CloudAppConfirmationMetadata {
  return (
    metadata?.roomId === roomId &&
    metadata.action === action &&
    typeof metadata.appId === "string" &&
    typeof metadata.appName === "string"
  );
}

export async function findPendingCloudAppConfirmation(
  runtime: IAgentRuntime,
  roomId: string,
  action: CloudAppConfirmationAction,
): Promise<PendingCloudAppConfirmation | null> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [CLOUD_APP_CONFIRM_TAG],
  });
  const matching = tasks
    .map((task): PendingCloudAppConfirmation | null => {
      const metadata = task.metadata as Record<string, unknown> | undefined;
      if (
        !task.id ||
        !isCloudAppConfirmationMetadata(metadata, roomId, action)
      ) {
        return null;
      }
      return {
        taskId: task.id,
        metadata,
      };
    })
    .filter((task): task is PendingCloudAppConfirmation => task !== null)
    .sort((a, b) => {
      const aAt =
        typeof a.metadata.intentCreatedAt === "string"
          ? Date.parse(a.metadata.intentCreatedAt) || 0
          : 0;
      const bAt =
        typeof b.metadata.intentCreatedAt === "string"
          ? Date.parse(b.metadata.intentCreatedAt) || 0
          : 0;
      return bAt - aAt;
    });

  return matching[0] ?? null;
}

export async function persistCloudAppConfirmation(
  runtime: IAgentRuntime,
  metadata: CloudAppConfirmationMetadata,
): Promise<void> {
  await runtime.createTask({
    name: `${metadata.action} confirm`,
    description: `Awaiting user confirmation for ${metadata.action}: ${metadata.appName}`,
    tags: [CLOUD_APP_CONFIRM_TAG],
    metadata: {
      ...metadata,
      intentCreatedAt: metadata.intentCreatedAt ?? new Date().toISOString(),
    },
  });
}

export async function deleteCloudAppConfirmation(
  runtime: IAgentRuntime,
  taskId: string,
): Promise<void> {
  await runtime
    .deleteTask(taskId as UUID)
    .catch((err) =>
      logger.warn(
        `[plugin-cloud-apps] failed to delete confirm task ${taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
}

/**
 * Build the first-phase confirmation prompt for a destructive action.
 *
 * Names the exact target (+ id when present), lists what is destroyed, and tells
 * the user the exact token to send back. `verb` defaults to "delete".
 */
export function confirmationPrompt(
  target: ConfirmTarget,
  destroys: string[],
  verb = "delete",
): string {
  const label = target.id
    ? `"${target.name}" (${target.id})`
    : `"${target.name}"`;
  const destroyClause =
    destroys.length > 0
      ? ` This permanently destroys ${joinList(destroys)}.`
      : "";
  return (
    `This will ${verb} ${label}.${destroyClause} This can't be undone. ` +
    `To go ahead, reply that you confirm ${verb} ${target.name}.`
  );
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Build a neutral connector CTA. The seam the DEFERRED paid actions reuse so a
 * connector can surface a "complete in browser" affordance. Throws if the URL is
 * not an http(s) URL — money/credentials must never be smuggled into the CTA.
 */
export function buildConnectorCta(
  label: string,
  url: string,
  kind: CtaKind = "link",
): ConnectorCta {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`buildConnectorCta: invalid URL "${url}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `buildConnectorCta: refusing non-http(s) URL "${parsed.protocol}"`,
    );
  }
  return { label, url: parsed.toString(), kind };
}

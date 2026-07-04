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
  | "BOOK_INFLUENCER"
  | "SUBMIT_PRESS_RELEASE";

export const CLOUD_APP_CONFIRM_TAG = "cloud-apps-confirm";

export interface CloudAppConfirmationMetadata {
  roomId: string;
  action: CloudAppConfirmationAction;
  appId: string;
  appName: string;
  appSlug?: string;
  amount?: number;
  /**
   * The confirmed charge in integer USD cents (BUY_APP_DOMAIN) — compared
   * exactly against the re-checked price at purchase time so the server never
   * debits a price the user did not confirm.
   */
  amountUsdCents?: number;
  /** The exact domain a pending BUY_APP_DOMAIN confirmation is for. */
  domain?: string;
  /**
   * True when the pending is a recovery retry of a money move whose earlier
   * attempt already (or may already) have committed server-side:
   * BUY_APP_DOMAIN — the purchase charged + registered but failed to attach
   * (the server finishes it without a new charge); BOOK_INFLUENCER — the fund
   * call failed at the transport level, so the escrow may already be held and
   * the pending's taskId is the sole holder of the idempotency key the server
   * dedupes/resumes on. Recovery retries complete without a second charge.
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

/**
 * A pending money confirmation is honored for this long; after that the gated
 * action refuses a bare confirm and asks the user to re-state the intent.
 * Shared by every gated action so a stale pending can never fund a
 * booking/purchase the user has long forgotten about.
 */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;

/**
 * True when a pending confirmation is older than {@link CONFIRM_TTL_MS}.
 *
 * A recovery retry never expires: it completes with no new charge — there is
 * no stale price to protect, and expiring it would strand money already
 * committed server-side (a paid, unattached domain; an influencer escrow whose
 * idempotency key only the pending still holds).
 */
export function pendingExpired(
  pending: PendingCloudAppConfirmation,
  now: number = Date.now(),
): boolean {
  if (pending.metadata.recovery === true) return false;
  const at =
    typeof pending.metadata.intentCreatedAt === "string"
      ? Date.parse(pending.metadata.intentCreatedAt)
      : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return now - at > CONFIRM_TTL_MS;
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

// ─── Confirm-turn target consistency (the "frozen target" guard) ─────────────
//
// The gated actions execute the params FROZEN at the first ask — the confirm
// turn is never re-parsed for new work. But when the confirm turn's own
// structured params clearly name a DIFFERENT target ("yes — delete Beta
// Dashboard" while the pending delete is for "Acme Bot"), executing the frozen
// target acts on something the user is no longer talking about. These helpers
// detect that conflict so the action refuses + clears the pending instead of
// mutating. They are deliberately lenient: a bare confirm, generic filler
// ("my app"), or a partial name of the SAME target never blocks.

/**
 * Planner-option keys that may carry the confirm turn's own app reference.
 * Mirrors the reference keys the actions resolve with at the first ask, minus
 * `query` (which can carry loose prose that must not read as a target switch).
 */
export const CONFIRM_APP_REFERENCE_KEYS = [
  "app",
  "appName",
  "name",
  "id",
  "appId",
] as const;

/** Filler words that alone never name a specific target ("my app", "it"). */
const GENERIC_REFERENCE_WORDS = new Set([
  "my",
  "the",
  "this",
  "that",
  "our",
  "your",
  "it",
  "its",
  "app",
  "apps",
  "application",
  "one",
  "domain",
  "influencer",
  "creator",
  "profile",
  "booking",
  "key",
  "earnings",
]);

function normalizeReference(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when the reference is generic filler that names no specific target. */
function isGenericReference(reference: string): boolean {
  return normalizeReference(reference)
    .split(" ")
    .every((word) => word.length === 0 || GENERIC_REFERENCE_WORDS.has(word));
}

/**
 * The confirm turn's own structured target reference, when the planner sent
 * one alongside `confirm` (nested `options.parameters` first — the real
 * planner path — then top-level). Null = a bare confirm with no reference.
 */
export function readConfirmTurnReference(
  options: unknown,
  keys: readonly string[],
): string | null {
  if (!options || typeof options !== "object") return null;
  const top = options as Record<string, unknown>;
  const nested =
    top.parameters && typeof top.parameters === "object"
      ? (top.parameters as Record<string, unknown>)
      : undefined;
  for (const source of nested ? [nested, top] : [top]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return null;
}

/**
 * True when `reference` plausibly names the frozen target: its id verbatim, or
 * a normalized exact/containment match on the name or an alias. Lenient on
 * purpose — a partial name ("acme" for "Acme Bot") or generic filler ("my
 * app") must NOT read as a target switch; only a clearly different name does.
 */
export function confirmReferenceMatchesTarget(
  reference: string,
  target: ConfirmTarget,
): boolean {
  const ref = normalizeReference(reference);
  if (ref.length === 0 || isGenericReference(reference)) return true;
  if (typeof target.id === "string" && normalizeReference(target.id) === ref) {
    return true;
  }
  const names = [target.name, ...(target.aliases ?? [])]
    .filter(
      (name): name is string =>
        typeof name === "string" && name.trim().length > 0,
    )
    .map(normalizeReference);
  return names.some(
    (name) => name === ref || name.includes(ref) || ref.includes(name),
  );
}

/**
 * The conflicting reference when the confirm turn's structured params name a
 * DIFFERENT target than the frozen pending snapshot — the gated action must
 * refuse (and clear the pending) instead of executing the frozen target. Null
 * = consistent: a bare confirm, or a reference matching the frozen target.
 */
export function conflictingConfirmTarget(
  options: unknown,
  target: ConfirmTarget,
  keys: readonly string[] = CONFIRM_APP_REFERENCE_KEYS,
): string | null {
  const reference = readConfirmTurnReference(options, keys);
  if (reference === null) return null;
  return confirmReferenceMatchesTarget(reference, target) ? null : reference;
}

/**
 * The conflicting amount when the confirm turn's structured params carry a
 * numeric amount that differs from the frozen one (e.g. "confirm — but only
 * $50" against a pending $100 withdrawal). Only trusts an unambiguous number
 * (a number, or a plain numeric string with an optional leading `$`); prose
 * never blocks. Null = consistent or no amount sent.
 */
export function conflictingConfirmAmount(
  options: unknown,
  frozenAmount: number,
): number | null {
  if (!options || typeof options !== "object") return null;
  const top = options as Record<string, unknown>;
  const nested =
    top.parameters && typeof top.parameters === "object"
      ? (top.parameters as Record<string, unknown>)
      : undefined;
  const value = nested?.amount ?? top.amount;
  let amount: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    amount = value;
  } else if (typeof value === "string") {
    const cleaned = value.trim().replace(/^\$/, "");
    if (/^\d+(\.\d+)?$/.test(cleaned)) amount = Number(cleaned);
  }
  if (amount === null) return null;
  return Math.abs(amount - frozenAmount) < 0.005 ? null : amount;
}

/**
 * The conflicting domain when the confirm turn's structured `domain` param
 * names a DIFFERENT domain than the frozen pending purchase. Domains are exact
 * identifiers, so unlike app names this is an exact comparison
 * (case-insensitive, ignoring a leading "www." and a trailing dot); values
 * that don't look like a domain never block. Null = consistent or none sent.
 */
export function conflictingConfirmDomain(
  options: unknown,
  frozenDomain: string,
): string | null {
  const reference = readConfirmTurnReference(options, ["domain"]);
  if (reference === null) return null;
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  const turn = normalize(reference);
  if (!turn.includes(".")) return null;
  return turn === normalize(frozenDomain) ? null : reference;
}

/**
 * The shared refusal copy for a confirm-turn target/amount conflict. Truthful:
 * nothing was executed and the pending confirmation has been cleared by the
 * caller before replying.
 */
export function confirmTargetMismatchMessage(
  requested: string,
  what: string,
  pendingName: string,
): string {
  return (
    `Your confirmation names "${requested}", but the pending ${what} was for "${pendingName}". ` +
    `To be safe I did nothing, and that pending confirmation is now cleared. ` +
    `Re-state what you want and I'll ask you to confirm again.`
  );
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

/**
 * Mark an existing pending confirmation as a recovery retry IN PLACE.
 *
 * The task is updated, never deleted + re-created: for BOOK_INFLUENCER the
 * taskId is the escrow idempotency key (`influencer-confirm-<taskId>`), so a
 * re-created task would mint a new key and let a user retry fund a SECOND
 * escrow instead of resuming the first (#11844). Failures are logged and
 * swallowed — the pending (and its key) survives either way; only the TTL
 * exemption is best-effort.
 */
export async function markCloudAppConfirmationRecovery(
  runtime: IAgentRuntime,
  pending: PendingCloudAppConfirmation,
): Promise<void> {
  try {
    await runtime.updateTask(pending.taskId as UUID, {
      metadata: { ...pending.metadata, recovery: true },
    });
  } catch (err) {
    logger.warn(
      `[plugin-cloud-apps] failed to mark confirm task ${pending.taskId} as recovery: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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

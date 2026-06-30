/**
 * Shared safety primitives for the plugin's destructive + paid actions.
 *
 * ── Two-phase confirm (connector-agnostic) ───────────────────────────────────
 * A destructive or paid action NEVER acts on the first ask. On the first turn it
 * returns a confirmation prompt that names the exact target and spells out what
 * will be destroyed, and it acts only when the FOLLOW-UP message carries an
 * explicit confirmation token (e.g. "yes delete <name>"). The token lives in the
 * user's plain message text, so the pattern behaves identically on Discord,
 * Telegram, the in-app chat, or any other surface — it never depends on a GUI
 * button or a connector-specific affordance. A bare first ask ("delete my Acme
 * app") carries no affirmation word, so it can never be mistaken for a
 * confirmation: the only way to proceed is to deliberately type the token.
 *
 * ── Connector-agnostic CTA (for the DEFERRED paid actions) ────────────────────
 * Paid actions that must hand the user off to a browser (withdraw earnings, buy
 * a domain — both deferred to Phase 3c) build a neutral {label,url,kind} object
 * the connector renders however it can (Discord link button, Telegram URL
 * button, in-app card). Money and credentials NEVER transit the connector: the
 * CTA carries only a human label plus an https URL the user opens themselves.
 * {@link buildConnectorCta} is the single seam those actions will reuse.
 */

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

export interface ConfirmCheckOptions {
  /**
   * Verbs that, combined with an affirmation word, count as confirmation even
   * when the target is not named. Defaults to the destructive set.
   */
  verbs?: string[];
}

/** Affirmation words that signal intent. Absent on a plain first ask. */
const AFFIRMATION =
  /\b(yes|yep|yeah|yup|confirm|confirmed|do it|go ahead|proceed|i'm sure|im sure)\b/i;

const DEFAULT_CONFIRM_VERBS = ["delete", "remove", "destroy"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercased references that unambiguously name the target. */
function targetReferences(target: ConfirmTarget): string[] {
  const refs: string[] = [];
  const pushIf = (value: string | undefined, minLen: number): void => {
    if (typeof value !== "string") return;
    const v = value.trim().toLowerCase();
    if (v.length >= minLen) refs.push(v);
  };
  // Names/slugs need >= 3 chars so a short alias can't match random words.
  pushIf(target.name, 3);
  for (const alias of target.aliases ?? []) pushIf(alias, 3);
  // The id is matched verbatim (a UUID fragment never collides with prose).
  pushIf(target.id, 6);
  return refs;
}

/**
 * True only when `text` is an EXPLICIT confirmation of acting on `target`.
 *
 * Requires an affirmation word AND either an action verb ("delete"/"remove"/…)
 * or a direct reference to the target (its name/slug/id). This is deliberately
 * strict: a first ask like "delete my Acme app" has no affirmation word and so
 * returns false, guaranteeing the destructive call never fires on the first ask.
 */
export function isExplicitConfirmation(
  text: string,
  target: ConfirmTarget,
  options: ConfirmCheckOptions = {},
): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (!AFFIRMATION.test(lower)) return false;

  const verbs = options.verbs ?? DEFAULT_CONFIRM_VERBS;
  const mentionsVerb = verbs.some((v) =>
    new RegExp(`\\b${escapeRegExp(v.toLowerCase())}\\b`).test(lower),
  );
  const mentionsTarget = targetReferences(target).some((ref) =>
    lower.includes(ref),
  );
  return mentionsVerb || mentionsTarget;
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
    `To go ahead, reply: ${verb} ${target.name} — yes.`
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

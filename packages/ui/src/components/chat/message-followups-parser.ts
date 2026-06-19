/**
 * Parser for `[FOLLOWUPS(?: id=<id>)?]\n...lines...\n[/FOLLOWUPS]` blocks
 * emitted by agent actions. Lives in its own module (mirroring
 * `message-choice-parser.ts`) so unit tests can exercise the regex/option
 * extraction without pulling the entire `MessageContent` React graph.
 *
 * Followups are dismissible, server-sourced suggestion chips rendered under a
 * message. Each chip is an *action*, encoded as `<kind>:<payload>=<label>`:
 *
 *   reply    — send `payload` as a new user message (default kind)
 *   navigate — dispatch the `eliza:navigate:view` event with the payload as a
 *              view id or `/`-prefixed view path (passive view-switch SUGGESTION)
 *   prompt   — prefill the composer with `payload` (falls back to reply)
 *
 * Lines without an explicit `<kind>:` prefix default to `reply`, so the simple
 * `value=label` shape used by `[CHOICE]` keeps working.
 */

export type FollowupKind = "reply" | "navigate" | "prompt";

export interface FollowupOption {
  kind: FollowupKind;
  /** For reply/prompt: the message text. For navigate: viewId or viewPath. */
  payload: string;
  label: string;
}

/** Hard cap so a runaway agent can't render an unbounded chip row. */
export const MAX_FOLLOWUPS = 4;

const FOLLOWUP_KINDS = new Set<FollowupKind>(["reply", "navigate", "prompt"]);

export const FOLLOWUPS_RE =
  /\[FOLLOWUPS(?:\s+id=(\S+))?\]\n([\s\S]*?)\n\[\/FOLLOWUPS\]/g;

export function generateFollowupsId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `followups-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Split a `<kind>:<payload>` head into its kind + payload, defaulting to reply. */
function parseHead(head: string): { kind: FollowupKind; payload: string } {
  const colon = head.indexOf(":");
  if (colon > 0) {
    const maybeKind = head.slice(0, colon).trim().toLowerCase();
    if (FOLLOWUP_KINDS.has(maybeKind as FollowupKind)) {
      return {
        kind: maybeKind as FollowupKind,
        payload: head.slice(colon + 1).trim(),
      };
    }
  }
  return { kind: "reply", payload: head.trim() };
}

export function parseFollowupsBody(body: string): FollowupOption[] {
  const options: FollowupOption[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (options.length >= MAX_FOLLOWUPS) break;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const { kind, payload } = parseHead(line.slice(0, eq));
    const label = line.slice(eq + 1).trim();
    if (!payload || !label) continue;
    options.push({ kind, payload, label });
  }
  return options;
}

export interface FollowupsMatch {
  start: number;
  end: number;
  id: string;
  options: FollowupOption[];
}

/** Find every FOLLOWUPS block in `text` and return their character regions. */
export function findFollowupsRegions(text: string): FollowupsMatch[] {
  const results: FollowupsMatch[] = [];
  FOLLOWUPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null = FOLLOWUPS_RE.exec(text);
  while (m !== null) {
    const id = m[1] && m[1].length > 0 ? m[1] : generateFollowupsId();
    const options = parseFollowupsBody(m[2]);
    if (options.length > 0) {
      results.push({
        start: m.index,
        end: m.index + m[0].length,
        id,
        options,
      });
    }
    m = FOLLOWUPS_RE.exec(text);
  }
  return results;
}

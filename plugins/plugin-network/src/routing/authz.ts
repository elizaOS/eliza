/**
 * Deterministic authorizer for model-PROPOSED Network actions, ported from the
 * Network agent prototype (`thenetwork-poc/prototypes/poc-agent-llm/src/authz.ts`).
 * The model only proposes; this code decides whether anything changes.
 *
 * Ported rules that apply to SET_STATE:
 *  - input sanitization (Unicode tag smuggling, zero-width/bidi controls, NFKC);
 *  - evidence must be a verbatim (normalized) quote of the member's own text and
 *    must not sit inside quoted / forwarded third-party text;
 *  - state must be one of the member states, and `until` a valid, future date.
 * The prototype's item attribution (`attribution.ts`: thread/opportunity
 * targeting by reply-to and timeline) only applies to item-targeting actions
 * (RELAY_MESSAGE, SCHEDULE, RESPOND_TO_OPPORTUNITY, ...) and is not needed for
 * a self-only SET_STATE; it ports with those actions.
 */
import { NETWORK_MEMBER_STATES, type NetworkMemberState } from "../types.js";

/** Applied before evidence comparison (prototype `sanitize`). */
export function sanitize(text: string): string {
  return text
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .normalize("NFKC");
}

const norm = (text: string) =>
  sanitize(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'+@.]+/gu, " ")
    .trim();

/** Spans quoting someone else: "...", “...”, and lines starting with ">". */
function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(/"([^"]{3,})"|“([^”]{3,})”/g)) {
    spans.push(match[1] ?? match[2] ?? "");
  }
  for (const line of text.split("\n")) {
    if (line.trim().startsWith(">")) spans.push(line.replace(/^\s*>/, ""));
  }
  return spans;
}

export function evidenceOk(
  evidence: string,
  memberText: string,
): { ok: true } | { ok: false; why: string } {
  const e = norm(evidence);
  const t = norm(memberText);
  if (e.length < 2) return { ok: false, why: "empty evidence" };
  if (!t.includes(e)) return { ok: false, why: "evidence not in member text" };
  if (quotedSpans(memberText).some((quote) => norm(quote).includes(e))) {
    return { ok: false, why: "evidence is inside quoted third-party text" };
  }
  return { ok: true };
}

export interface ProposedSetState {
  state: NetworkMemberState;
  until: string | null;
  evidence: string;
}

export type SetStateDecision =
  | { allowed: true; state: NetworkMemberState; until: string | null }
  | { allowed: false; reason: string };

export function authorizeSetState(
  proposal: { state: unknown; until: unknown; evidence: unknown },
  memberText: string,
  now: Date = new Date(),
): SetStateDecision {
  if (
    typeof proposal.state !== "string" ||
    !(NETWORK_MEMBER_STATES as readonly string[]).includes(proposal.state)
  ) {
    return { allowed: false, reason: "invalid state" };
  }
  if (typeof proposal.evidence !== "string") {
    return { allowed: false, reason: "missing evidence" };
  }
  const evidence = evidenceOk(proposal.evidence, memberText);
  if (!evidence.ok) return { allowed: false, reason: evidence.why };
  let until: string | null = null;
  if (typeof proposal.until === "string" && proposal.until.trim()) {
    const parsed = Date.parse(proposal.until);
    if (Number.isNaN(parsed)) return { allowed: false, reason: "invalid until" };
    // Allow a date-only "today"; reject anything already in the past.
    if (parsed < now.getTime() - 24 * 60 * 60 * 1000) {
      return { allowed: false, reason: "until is in the past" };
    }
    until = new Date(parsed).toISOString();
  }
  return {
    allowed: true,
    state: proposal.state as NetworkMemberState,
    until: proposal.state === "open" ? null : until,
  };
}

/**
 * Deployment-configurable canonicalization of deliverable URLs at the
 * completion-relay boundary. A child agent that ships through a hosting
 * provider often narrates the provider's origin host ("agent-home.vercel.app")
 * even when its spawn-route instructions name the public custom domain
 * ("nubilio.org"); every user-facing relay must carry the canonical public
 * name, so the parent rewrites deterministically here instead of trusting the
 * child's phrasing. Consumers: the sub-agent router's completion relay, the
 * swarm coordinator's synthesis summary, the progress-narration funnel, and
 * (via the package root) packages/agent's swarm-synthesis path.
 *
 * Only the host of an http(s) URL whose host EXACTLY matches a configured key
 * is replaced; scheme, userinfo, path, query, and fragment are preserved
 * byte-for-byte (the port is dropped with the host it belonged to — the
 * canonical public name serves on its default port). All other text is
 * untouched. PROMPT-INTEGRITY: this is a lossless canonicalization — the same
 * resource under its canonical public name — never a truncation or a
 * size/item ceiling on relay-deliverable content.
 *
 * Configured by ELIZA_DELIVERABLE_URL_REWRITES, a JSON object mapping exact
 * URL host → replacement host (e.g. {"agent-home.vercel.app":"nubilio.org"}),
 * read runtime.getSetting → config env → process.env like
 * TASK_AGENT_WORKDIR_ROUTES. Malformed config degrades to "no rewrites" with
 * a warn — the relay path must never throw over an operator typo.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";

export const DELIVERABLE_URL_REWRITES_SETTING =
  "ELIZA_DELIVERABLE_URL_REWRITES";

/** Scheme + authority of an http(s) URL. Path, query, and fragment stay
 *  OUTSIDE the match, so a rewrite can never touch them. */
const URL_AUTHORITY_PATTERN = /(https?:\/\/)([^\s/?#]+)/gi;

/** Hostname shape for configured keys/values: DNS labels only. Anything else
 *  (paths, schemes, spaces smuggled into config) is structurally dropped. */
const HOST_SHAPE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Rewrite the host of every http(s) URL in `text` whose host exactly matches
 * a key of `rewrites` (case-insensitive, as DNS is) to the mapped replacement
 * host. Non-matching URLs and all surrounding text are returned unchanged. A
 * numeric port is dropped when its host is rewritten; a root-anchored trailing
 * dot ("host.") matches its dotless key and keeps the dot, so sentence
 * punctuation is never eaten.
 */
export function canonicalizeDeliverableUrls(
  text: string,
  rewrites: Record<string, string>,
): string {
  if (!text) return text;
  const byHost = new Map<string, string>();
  for (const [host, replacement] of Object.entries(rewrites)) {
    if (typeof replacement !== "string") continue;
    const key = host.trim().toLowerCase();
    const value = replacement.trim();
    if (key && HOST_SHAPE.test(key) && value && HOST_SHAPE.test(value)) {
      byHost.set(key, value);
    }
  }
  if (byHost.size === 0) return text;
  URL_AUTHORITY_PATTERN.lastIndex = 0;
  return text.replace(
    URL_AUTHORITY_PATTERN,
    (match, scheme: string, authority: string) => {
      const at = authority.lastIndexOf("@");
      const userinfo = at >= 0 ? authority.slice(0, at + 1) : "";
      const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
      // Split a trailing numeric port; anything else (IPv6 literals, odd
      // shapes) stays part of the "host" and simply never matches a key.
      const colon = hostPort.lastIndexOf(":");
      const portIsNumeric =
        colon >= 0 && /^\d+$/.test(hostPort.slice(colon + 1));
      const host = portIsNumeric ? hostPort.slice(0, colon) : hostPort;
      const lower = host.toLowerCase();
      const direct = byHost.get(lower);
      const rootAnchored =
        direct === undefined && lower.endsWith(".")
          ? byHost.get(lower.slice(0, -1))
          : undefined;
      const replacement = direct ?? rootAnchored;
      if (replacement === undefined) return match;
      const trailingDot = rootAnchored !== undefined ? "." : "";
      return `${scheme}${userinfo}${replacement}${trailingDot}`;
    },
  );
}

/** Single-slot memo of the last parsed raw value: the relay/narration paths
 *  call this per event, and the memo both skips re-parsing an unchanged
 *  setting and keeps the malformed-config warn to once per distinct value. */
let lastRaw: string | undefined;
let lastParsed: Record<string, string> = {};

/**
 * Parse a raw ELIZA_DELIVERABLE_URL_REWRITES value into a validated
 * host → host map. Malformed JSON, a non-object root, or a structurally
 * invalid entry produces an explicit empty/partial result with a warn —
 * never a throw (this runs at relay time).
 */
export function parseDeliverableUrlRewrites(
  raw: string | undefined,
): Record<string, string> {
  if (!raw?.trim()) return {};
  if (raw === lastRaw) return lastParsed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // error-policy:J3 untrusted deployment config; ELIZA_DELIVERABLE_URL_REWRITES
    // parse failure → warn + explicit no-rewrites result, never a relay-time throw.
    logger.warn(
      `[deliverable-links] Failed to parse ${DELIVERABLE_URL_REWRITES_SETTING}: ${(err as Error).message}`,
    );
    lastRaw = raw;
    lastParsed = {};
    return lastParsed;
  }
  const out: Record<string, string> = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [host, replacement] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const key = host.trim().toLowerCase();
      const value = typeof replacement === "string" ? replacement.trim() : "";
      if (key && HOST_SHAPE.test(key) && value && HOST_SHAPE.test(value)) {
        out[key] = value;
      } else {
        logger.warn(
          `[deliverable-links] Dropping malformed ${DELIVERABLE_URL_REWRITES_SETTING} entry for ${JSON.stringify(host)} (want exact host → host strings)`,
        );
      }
    }
  } else {
    logger.warn(
      `[deliverable-links] ${DELIVERABLE_URL_REWRITES_SETTING} must be a JSON object of host → host strings; ignoring`,
    );
  }
  lastRaw = raw;
  lastParsed = out;
  return out;
}

/**
 * Read the configured rewrites map the same way TASK_AGENT_WORKDIR_ROUTES is
 * read: runtime.getSetting first (character settings), then the config file's
 * env section (UI-written, no restart needed), then process.env.
 */
export function readDeliverableUrlRewrites(
  runtime?: IAgentRuntime,
): Record<string, string> {
  const fromRuntime =
    typeof runtime?.getSetting === "function"
      ? runtime.getSetting(DELIVERABLE_URL_REWRITES_SETTING)
      : undefined;
  const raw =
    typeof fromRuntime === "string" && fromRuntime.length > 0
      ? fromRuntime
      : (readConfigEnvKey(DELIVERABLE_URL_REWRITES_SETTING) ??
        process.env[DELIVERABLE_URL_REWRITES_SETTING]);
  return parseDeliverableUrlRewrites(typeof raw === "string" ? raw : undefined);
}

/** One-call form for relay choke points: read the deployment's rewrites and
 *  canonicalize `text`; with nothing configured the text passes through. */
export function canonicalizeDeliverableUrlsForRuntime(
  runtime: IAgentRuntime | undefined,
  text: string,
): string {
  if (!text) return text;
  const rewrites = readDeliverableUrlRewrites(runtime);
  if (Object.keys(rewrites).length === 0) return text;
  return canonicalizeDeliverableUrls(text, rewrites);
}

/**
 * Child → parent `USE_SKILL parent-agent` dispatcher.
 *
 * A spawned coding agent (driven over ACP) cannot run account-bound Eliza Cloud
 * commands itself. The `build-monetized-app` skill and the SKILLS.md written for
 * economics tasks tell it to emit `USE_SKILL parent-agent <json>` in its output
 * instead. This module is the production caller the economics runbook
 * (`docs/economics-goal-runbook.md`) identified as missing: it detects that
 * directive in the child's streamed text, bridges it to `runParentAgentBroker`,
 * and sends the broker's reply back into the child session so the loop
 * continues (read cloud commands, self-authorize spend within the cap, etc.).
 *
 * The detection is intentionally narrow — it only acts on text containing the
 * literal `USE_SKILL parent-agent` marker, which ordinary coding tasks never
 * emit, so wiring it into the session-event hot path is inert for every other
 * flow.
 *
 * @module services/parent-agent-dispatch
 */

import type { IAgentRuntime, Logger } from "@elizaos/core";
import type { AcpService } from "./acp-service.js";
import {
  PARENT_AGENT_BROKER_SLUG,
  runParentAgentBroker,
} from "./parent-agent-broker.js";
import type { SessionInfo } from "./types.js";

const DISPATCH_LOG_SRC = "acpx:parent-agent-dispatch";

/** The exact prefix a child emits to invoke the parent-agent broker. */
export const PARENT_AGENT_DIRECTIVE_MARKER = `USE_SKILL ${PARENT_AGENT_BROKER_SLUG}`;

export interface ParentAgentDirective {
  /** Parsed JSON args object, passed verbatim to the broker as `args`. */
  args: Record<string, unknown>;
  /** Offset just past the directive in the source string (for buffer trimming). */
  endIndex: number;
}

/** Index of the first directive marker in `text`, or -1. */
export function parentAgentMarkerIndex(text: string): number {
  return text.indexOf(PARENT_AGENT_DIRECTIVE_MARKER);
}

/**
 * Find the FIRST complete `USE_SKILL parent-agent {json}` directive in `text`.
 *
 * Returns `null` when no marker is present, or when the JSON object after the
 * marker is not yet balanced (the directive is still streaming) — the caller
 * keeps buffering in that case. The scan is string- and escape-aware so braces
 * inside JSON string values do not close the object early. A malformed object
 * (balanced braces that fail `JSON.parse`) resolves to `null` so the caller
 * does not spin on it.
 */
export function extractParentAgentDirective(
  text: string,
): ParentAgentDirective | null {
  const markerAt = text.indexOf(PARENT_AGENT_DIRECTIVE_MARKER);
  if (markerAt < 0) return null;

  // Skip whitespace / a markdown backtick between the marker and the JSON.
  let i = markerAt + PARENT_AGENT_DIRECTIVE_MARKER.length;
  while (i < text.length && text[i] !== "{") {
    const ch = text[i];
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r" && ch !== "`") {
      // Non-JSON content after the marker → not a directive.
      return null;
    }
    i++;
  }
  if (i >= text.length) return null; // brace not streamed yet

  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return {
              args: parsed as Record<string, unknown>,
              endIndex: i + 1,
            };
          }
        } catch {
          // Balanced but not valid JSON — drop it (caller trims past the marker).
        }
        return null;
      }
    }
  }
  return null; // unbalanced — still streaming
}

export interface DispatchParentAgentParams {
  runtime: IAgentRuntime;
  /** Only the methods the dispatcher needs, so tests can pass a tiny stub. */
  acp: Pick<AcpService, "sendToSession">;
  sessionId: string;
  session?: SessionInfo;
  args: Record<string, unknown>;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Run one parent-agent directive through the broker and send the reply back to
 * the child session. Never throws: a broker failure is reported back to the
 * child as text so it is not left waiting on a response that never comes.
 */
export async function dispatchParentAgentDirective(
  params: DispatchParentAgentParams,
): Promise<{ ok: boolean; reply: string }> {
  const { runtime, acp, sessionId, session, args, log } = params;

  let reply: string;
  let ok = false;
  try {
    const result = await runParentAgentBroker({
      runtime,
      sessionId,
      session,
      args,
    });
    ok = result.success;
    reply = result.text;
  } catch (err) {
    reply = `parent-agent bridge error: ${err instanceof Error ? err.message : String(err)}`;
    log?.error?.({ src: DISPATCH_LOG_SRC, sessionId }, reply);
  }

  try {
    await acp.sendToSession(sessionId, reply);
  } catch (err) {
    log?.warn?.(
      { src: DISPATCH_LOG_SRC, sessionId },
      `failed to deliver parent-agent reply: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reply };
  }
  return { ok, reply };
}

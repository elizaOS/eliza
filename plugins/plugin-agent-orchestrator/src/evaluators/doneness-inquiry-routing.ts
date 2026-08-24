/**
 * Deterministic stage-1 routing for doneness/completion questions about
 * delegated work. The planner's model routing is not stable here: "is the
 * color page done? link me" routed to APP+LIST_CLOUD_APPS and dumped a
 * 10-app catalog instead of answering the question (live 2026-08-21). The
 * durable task record is the ground truth for "is it done" / "wheres my
 * link", so when the phrasing is a doneness inquiry and the room actually
 * has delegated work to ask about, the candidate surface is narrowed to the
 * TASKS history/status surface instead of hoping the model picks it.
 *
 * Two-tier assist: with room-scoped sub-agent lanes on record the candidate
 * surface is REPLACED (the catalog hijack is a live failure); without any
 * lane the TASKS history candidate is merely ADDED, leaving the planner's
 * own candidates intact for rooms where the question may not be about
 * delegated work at all.
 */
import type { Memory, ResponseHandlerEvaluator } from "@elizaos/core";
import { unwrapUserMessageText } from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import {
  DELIVERABLE_NOUN_RE,
  looksLikeDonenessInquiry,
  looksLikeNewDeliverableAsk,
} from "../services/ask-shapes.js";

/** Connector-rendered mention of the agent that leads an addressed message —
 *  not part of the ask (same strip as finished-work-followup-routing). */
const LEADING_MENTION_RE =
  /^\s*(?:<@!?\d+>\s*|@\S+\s+|[^()\n]{0,80}\(@\d+\)\s*)/u;

function messageText(message: Memory): string {
  return unwrapUserMessageText(message).replace(LEADING_MENTION_RE, "").trim();
}

const TOKEN_STOPWORDS = new Set([
  "done",
  "ready",
  "finished",
  "complete",
  "completed",
  "deployed",
  "live",
  "link",
  "page",
  "site",
  "build",
  "that",
  "this",
  "the",
  "yet",
  "please",
  "still",
  "what",
  "where",
  "wheres",
  "when",
  "have",
  "has",
  "did",
  "does",
  "is",
  "are",
  "was",
  "were",
  "my",
  "me",
  "it",
  "its",
  "app",
  "with",
  "for",
  "and",
  "you",
]);

/** Lowercased content tokens (length ≥ 3, stopwords out) for name matching. */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !TOKEN_STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Whether the ask's tokens overlap a lane's label/original task — how a
 *  bare app NAME ("is daily hue done?") grounds without a category noun. */
function overlapsLane(
  askTokens: Set<string>,
  label: string,
  initialTask: string,
): boolean {
  if (askTokens.size === 0) return false;
  const laneTokens = contentTokens(`${label} ${initialTask}`);
  for (const token of askTokens) {
    if (laneTokens.has(token)) return true;
  }
  return false;
}

export const donenessInquiryRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.doneness-inquiry-routing",
  description:
    "Routes doneness/completion questions about delegated work to the TASKS history surface deterministically.",
  priority: 20,
  shouldRun: ({ message }) => {
    const text = messageText(message);
    return (
      text.length > 0 &&
      looksLikeDonenessInquiry(text) &&
      // "make me a page and tell me when its done" is a NEW build ask.
      !looksLikeNewDeliverableAsk(text)
    );
  },
  evaluate: async ({ runtime, message, messageHandler }) => {
    if (messageHandler.processMessage !== "RESPOND") return undefined;
    const text = messageText(message);
    const roomId = String(message.roomId ?? "");
    const service = getAcpService(runtime);
    let roomLanes: Array<{ label: string; initialTask: string }> = [];
    if (service) {
      try {
        const sessions = await Promise.resolve(service.listSessions());
        roomLanes = (Array.isArray(sessions) ? sessions : [])
          .filter((s) => {
            const meta = s.metadata as Record<string, unknown> | undefined;
            return (
              typeof meta?.roomId === "string" &&
              (!roomId || meta.roomId === roomId)
            );
          })
          .map((s) => {
            const meta = s.metadata as Record<string, unknown> | undefined;
            return {
              label: String(meta?.label ?? ""),
              initialTask: String(meta?.initialTask ?? "").slice(0, 400),
            };
          });
      } catch {
        // error-policy:J4 routing enrichment only — an unavailable session
        // list degrades to the soft (add-only) assist below.
        roomLanes = [];
      }
    }
    const namesDeliverable = DELIVERABLE_NOUN_RE.test(text);
    const askTokens = contentTokens(text);
    const matchesLane = roomLanes.some((lane) =>
      overlapsLane(askTokens, lane.label, lane.initialTask),
    );
    // A bare-name ask ("is daily hue done?") must actually match a known lane
    // — without a category noun OR a lane match, this room's "is it ready?"
    // may not be about delegated work at all.
    if (!namesDeliverable && !matchesLane) return undefined;
    if (roomLanes.length > 0) {
      return {
        clearCandidateActions: true,
        addCandidateActions: ["TASKS", "TASKS_HISTORY", "TASK_HISTORY"],
        // TASKS' contextGate accepts automation; without it the planner can
        // reject the injected candidates as out-of-context.
        addContextSlices: ["automation"],
        debug: [
          "doneness inquiry about delegated work: candidate surface narrowed to TASKS history",
        ],
      };
    }
    return {
      addCandidateActions: ["TASKS", "TASKS_HISTORY", "TASK_HISTORY"],
      addContextSlices: ["automation"],
      debug: [
        "doneness inquiry with no room lanes on record: TASKS history candidate added (surface not narrowed)",
      ],
    };
  },
};

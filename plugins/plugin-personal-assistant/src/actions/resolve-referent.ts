/**
 * `RESOLVE_REFERENT` action — the live consumer of the implicit-referent
 * resolver.
 *
 * When the owner issues an under-specified ask ("book the usual", "clear my
 * afternoon, you know why"), this action gathers candidate referents from the
 * owner's real stores ({@link gatherImplicitReferentCandidates} — fact memory
 * table + OwnerFactStore) and ranks them with {@link resolveImplicitReferent}.
 * It is preview-first by construction: it never executes the underlying
 * operation. A confident resolution returns the confirmation preview text (the
 * downstream executor action still runs behind an approval), and an ambiguous
 * ask is recorded as an open disambiguating question in the PendingPromptsStore
 * so the owner's next reply reopens it — the same pending-prompt channel the
 * scheduled-task runner uses.
 *
 * The `prior` (semantic-relevance) signal is supplied by the candidate sources
 * from each fact's persisted `similarity`/`confidence`; it is not fabricated
 * here. Embedding/BM25 retrieval will strengthen that prior upstream without
 * changing this call site.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { gatherImplicitReferentCandidates } from "../lifeops/implicit-referents/candidate-sources.js";
import { resolveImplicitReferent } from "../lifeops/implicit-referents/index.js";
import { resolvePendingPromptsStore } from "../lifeops/pending-prompts/store.js";
import { messageText } from "../lifeops/voice/grounded-reply.js";

/**
 * Markers a bare ask carries when it points at prior context rather than naming
 * its own referent. Only these route to the resolver; a fully-specified ask
 * needs no referent resolution and should reach its domain action directly.
 */
const IMPLICIT_MARKERS = [
  "the usual",
  "you know why",
  "you know which",
  "same as last time",
  "same reason",
  "last time",
  "as always",
  "like always",
  "the same one",
] as const;

function isImplicitAsk(ask: string): boolean {
  const normalized = ask.toLowerCase();
  return IMPLICIT_MARKERS.some((marker) => normalized.includes(marker));
}

export const resolveReferentAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "RESOLVE_REFERENT",
  similes: [
    "RESOLVE_IMPLICIT_REFERENT",
    "DISAMBIGUATE_REFERENT",
    "WHICH_ONE",
    "THE_USUAL",
  ],
  description:
    "Resolve an under-specified owner ask ('book the usual', 'clear my afternoon, you know why', 'same as last time') by ranking candidate referents from the owner's facts and preferences. Preview-first: returns the resolved interpretation for confirmation, or asks one disambiguating question. Does NOT execute the underlying operation.",
  descriptionCompressed:
    "resolve implicit owner ask ('the usual'/'you know why'/'same as last time') -> confirm interpretation or ask one disambiguating question; preview-first, no execution",
  routingHint:
    "under-specified ask that leans on prior context ('book the usual', 'you know why', 'same as last time') -> RESOLVE_REFERENT; a fully-named request goes straight to its domain action (CALENDAR/OWNER_REMINDERS/...)",
  tags: ["domain:assistant", "capability:read", "surface:internal"],
  contexts: ["memory", "tasks", "calendar", "messaging"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (_runtime: IAgentRuntime, message: Memory) =>
    isImplicitAsk(messageText(message)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Resolving your requests is restricted to the owner.";
      await callback?.({ text, source: "action", action: "RESOLVE_REFERENT" });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const ask = messageText(message).trim();
    const candidates = await gatherImplicitReferentCandidates(runtime);
    const resolution = resolveImplicitReferent({
      ask,
      nowIso: new Date().toISOString(),
      candidates,
    });

    if (resolution.decision === "resolved") {
      const text = resolution.confirmationText;
      await callback?.({ text, source: "action", action: "RESOLVE_REFERENT" });
      return {
        text,
        success: true,
        data: {
          decision: "resolved",
          selectedId: resolution.selected.candidate.id,
          executorHint: resolution.selected.candidate.executorHint ?? null,
          score: resolution.selected.score,
        },
      };
    }

    // Ambiguous ask: record the disambiguating question as an open pending
    // prompt so the owner's next reply reopens this thread, then surface it.
    const text = resolution.question;
    await resolvePendingPromptsStore(runtime).record({
      roomId: message.roomId,
      taskId: `implicit-referent:${message.id ?? ask}`,
      promptSnippet: text,
      firedAt: new Date().toISOString(),
      expectedReplyKind: "free_form",
    });
    await callback?.({ text, source: "action", action: "RESOLVE_REFERENT" });
    return {
      text,
      success: true,
      data: {
        decision: "ask",
        rankedIds: resolution.ranked.map((entry) => entry.candidate.id),
      },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Book the usual." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Resolving "Book the usual." as booking the Osteria corner table.',
          action: "RESOLVE_REFERENT",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Clear it, you know why." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Do you mean the board prep block or the investor prep block?",
          action: "RESOLVE_REFERENT",
        },
      },
    ],
  ],
};

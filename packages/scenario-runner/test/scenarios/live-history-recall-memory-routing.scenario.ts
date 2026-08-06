/**
 * Live proof for the Stage-1 history-capability gate (#17564, with-MEMORY
 * branch): on a runtime whose role-visible MEMORY action exposes op:search,
 * a beyond-window count question ("how many times have i mentioned bitcoin")
 * must route to the stored record instead of being answered — or denied —
 * from the visible message window alone (live regression tj-69d82bb89ebb69).
 *
 * Seeds a stored conversation with three bitcoin mentions, asks the count
 * question through the full live pipeline, and requires a real MEMORY action
 * invocation plus a count-shaped answer. The paired scenario
 * live-history-recall-honest-denial covers the no-executable-action branch.
 */

import type { Memory, UUID } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { prepareOwnerMemoryRuntime } from "./_helpers/history-recall-runtime";

type ActionParameterLike = {
  name?: string;
  schema?: { enum?: string[]; enumValues?: string[] };
};

type RuntimeLike = {
  agentId: UUID;
  actions?: Array<{ name?: string; parameters?: ActionParameterLike[] }>;
  createMemory(memory: Memory, tableName: string): Promise<unknown>;
};

const SEEDED_HISTORY = [
  "good morning",
  "i think bitcoin is going to rip this week",
  "anyway how was your day",
  "my cousin keeps texting me about bitcoin again",
  "we should plan that trip soon",
  "ok last one i promise: bitcoin just crossed my price alert",
  "unrelated: remind me to water the plants",
];

function hasExecutableMemorySearch(runtime: RuntimeLike): boolean {
  return (runtime.actions ?? []).some(
    (action) =>
      String(action.name).toUpperCase() === "MEMORY" &&
      (action.parameters ?? []).some((parameter) =>
        [
          ...(parameter.schema?.enum ?? []),
          ...(parameter.schema?.enumValues ?? []),
        ].some((value) => String(value).toUpperCase() === "SEARCH"),
      ),
  );
}

async function seedStoredHistory(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const prepared = await prepareOwnerMemoryRuntime(ctx);
  if (typeof prepared === "string") return prepared;
  const runtime = prepared as RuntimeLike;
  if (!ctx.primaryRoomId || !ctx.primaryUserId) {
    return "executor did not expose primaryRoomId/primaryUserId to seeds";
  }
  // The gate under test only advertises history search when the executable
  // surface exists; fail loudly here rather than passing on a runtime where
  // the with-MEMORY branch never renders.
  if (!hasExecutableMemorySearch(runtime)) {
    return "runtime has no MEMORY action with a search discriminator; this scenario proves the with-MEMORY branch and cannot run without it";
  }
  const base = Date.now() - SEEDED_HISTORY.length * 60_000;
  for (const [index, text] of SEEDED_HISTORY.entries()) {
    await runtime.createMemory(
      {
        id: crypto.randomUUID() as UUID,
        entityId: ctx.primaryUserId as UUID,
        agentId: runtime.agentId,
        roomId: ctx.primaryRoomId as UUID,
        content: { text, source: "chat" },
        createdAt: base + index * 60_000,
      },
      "messages",
    );
  }
  return undefined;
}

export default scenario({
  id: "live-history-recall-memory-routing",
  lane: "live-only",
  title:
    "Beyond-window history count routes to the MEMORY search surface instead of the visible window",
  domain: "scenario-runner",
  tags: ["live", "real-llm", "stage1", "memory", "history-recall", "17564"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "History recall routing",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed stored conversation with three bitcoin mentions",
      apply: seedStoredHistory,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "beyond-window count question reaches the stored record",
      room: "main",
      text: "how many times have i mentioned bitcoin in this channel?",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The assistant must answer with a count of the user's bitcoin mentions grounded in a search of stored history (three seeded mentions; an answer of 3, or a close count with the matching messages cited, passes). A reply that denies having a way to search chat history, answers only from the few visible recent messages ('I don't see any mention...'), or claims it searched without producing a result, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MEMORY",
      status: "success",
      minCount: 1,
    },
  ],
});

/**
 * Live-model memory lifecycle evaluation against the real SQL-backed AgentRuntime.
 * It places durable facts six months behind 30 similar distractors, then drives
 * search, correction, supersession, deletion, and an honest post-delete miss via chat.
 */
import { type Memory, MemoryType, type UUID } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { scoreMemoryRecall } from "../../src/memory-recall-metrics";
import { prepareOwnerMemoryRuntime } from "./_helpers/history-recall-runtime";

const DISTRACTOR_COUNT = 30;
const OLD_CODENAME = "Kingfisher";
const NEW_CODENAME = "Nightjar";
const LOCKER_CODE = "7391";

type SeedRuntime = {
  agentId: UUID;
  createMemories(
    memories: Array<{
      memory: Memory;
      tableName: string;
      unique?: boolean;
    }>,
  ): Promise<UUID[]>;
};

async function seedLongHorizonMemory(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const prepared = await prepareOwnerMemoryRuntime(ctx);
  if (typeof prepared === "string") return prepared;
  if (!ctx.primaryRoomId || !ctx.primaryUserId) {
    return "scenario runtime did not expose the owner room and entity";
  }
  const runtime = prepared as SeedRuntime;
  const base = new Date("2026-02-01T12:00:00.000Z").getTime();
  const facts = [
    `The owner's project codename is ${OLD_CODENAME}.`,
    `The owner's temporary locker code is ${LOCKER_CODE}.`,
    "The owner's preferred afternoon tea is oolong.",
    ...Array.from(
      { length: DISTRACTOR_COUNT },
      (_, index) =>
        `Archived project note ${String(index).padStart(4, "0")}: reference bird ${index % 2 === 0 ? "kestrel" : "sparrow"}, locker ${8_000 + index}, tea ${index % 3 === 0 ? "earl grey" : "sencha"}.`,
    ),
  ];
  const rows = facts.map((text, index) => ({
    memory: {
      id: crypto.randomUUID() as UUID,
      entityId: ctx.primaryUserId as UUID,
      agentId: runtime.agentId,
      roomId: ctx.primaryRoomId as UUID,
      content: { text, source: "memory-lifecycle-eval" },
      metadata: {
        type: MemoryType.CUSTOM,
        source: "memory-lifecycle-eval",
        kind: "durable",
        category: "evaluation_fact",
        confidence: 1,
      },
      createdAt: base + index * 60_000,
      unique: false,
    } satisfies Memory,
    tableName: "facts",
    unique: false,
  }));
  await runtime.createMemories(rows);
  return undefined;
}

function scoreLifecycle(ctx: ScenarioContext): string | undefined {
  const firstRecall = ctx.turns?.[0]?.responseText ?? "";
  const correctedRecall = ctx.turns?.[2]?.responseText ?? "";
  const forgottenRecall = ctx.turns?.[4]?.responseText ?? "";
  const score = scoreMemoryRecall([
    {
      id: "six-month-recall",
      response: firstRecall,
      expected: [OLD_CODENAME],
      forbidden: ["kestrel"],
    },
    {
      id: "superseded-recall",
      response: correctedRecall,
      expected: [NEW_CODENAME],
      forbidden: [OLD_CODENAME],
    },
    {
      id: "post-delete-honest-miss",
      response: forgottenRecall,
      expected: [],
      forbidden: [LOCKER_CODE],
    },
  ]);
  if (score.kind === "invalid") return score.reason;
  if (score.recall < 1 || score.precision < 1) {
    return `memory recall quality missed the perfect lifecycle threshold: ${JSON.stringify(score)}`;
  }
  if (score.falsePositiveRate !== 0) {
    return `memory recall produced a forbidden stale or deleted fact: ${JSON.stringify(score)}`;
  }
  return undefined;
}

export default scenario({
  id: "live-memory-lifecycle-long-horizon",
  lane: "live-only",
  title:
    "Memory survives a six-month horizon and supports correction plus forgetting",
  domain: "scenario-runner",
  tags: [
    "live",
    "real-llm",
    "memory",
    "long-horizon",
    "crud",
    "quality-metrics",
  ],
  isolation: "per-scenario",
  now: "2026-08-25T12:00:00.000Z",
  rooms: [
    {
      id: "main",
      source: "chat",
      channelType: "DM",
      title: "Long-horizon memory lifecycle",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed six-month-old targets behind 30 distractors",
      apply: seedLongHorizonMemory,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "recall an old fact through stored-memory search",
      room: "main",
      text: "What is my project codename? Search my stored memory before answering.",
      responseIncludesAny: [OLD_CODENAME.toLowerCase()],
      responseExcludes: [/kestrel/i],
    },
    {
      kind: "message",
      name: "correct and supersede the old fact",
      room: "main",
      text: `Replace the stored project-codename memory. It is ${NEW_CODENAME}, not ${OLD_CODENAME}. This is explicit confirmation to update it.`,
    },
    {
      kind: "message",
      name: "recall only the corrected fact",
      room: "main",
      text: "What is my current project codename? Search stored memory again.",
      responseIncludesAny: [NEW_CODENAME.toLowerCase()],
      responseExcludes: [new RegExp(OLD_CODENAME, "i")],
    },
    {
      kind: "message",
      name: "forget a specific stored fact",
      room: "main",
      text: `Forget my stored temporary locker code ${LOCKER_CODE}. I explicitly confirm deletion.`,
    },
    {
      kind: "message",
      name: "deleted fact stays unavailable",
      room: "main",
      text: "What was my temporary locker code? Search stored memory and be honest if it is gone.",
      responseExcludes: [new RegExp(LOCKER_CODE)],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MEMORY_SEARCH",
      status: "success",
      minCount: 2,
    },
    {
      type: "actionCalled",
      actionName: "MEMORY_UPDATE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "MEMORY_DELETE",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "quantitative recall quality is perfect across lifecycle cases",
      predicate: scoreLifecycle,
    },
  ],
});

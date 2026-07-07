/**
 * Deterministic (keyless) proof for the passive preference evaluator (#14675):
 * the `preferences` evaluator must be registered on a real runtime boot, its
 * processor must route a parsed extraction into the REAL stores (a personality
 * slot trait with `agent_inferred` provenance, and a durable `preference` fact
 * row in the facts table), and the re-injection path must close the loop —
 * `userPersonalityPreferences` renders the inferred trait into the next turn's
 * prompt context.
 *
 * Runs zero turns: the LLM judgment half of the evaluator (prompt → ops) is
 * covered by unit tests and live lanes; this scenario pins the wiring —
 * registration → write policy → storage rows → prompt injection — through the
 * real runtime with no model call.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const FACT_CLAIM = "prefers the dark background in the app";

interface ProviderResultLike {
  text: string;
}

interface ProviderLike {
  name: string;
  get(
    runtime: unknown,
    message: Record<string, unknown>,
    state: Record<string, unknown>,
  ): Promise<ProviderResultLike>;
}

interface ProcessorLike {
  process(context: Record<string, unknown>): Promise<unknown>;
}

interface EvaluatorLike {
  name: string;
  processors?: ProcessorLike[];
}

interface PersonalitySlotLike {
  verbosity: string | null;
  source: string;
  custom_directives: string[];
}

interface PersonalityStoreLike {
  getSlot(userId: string): PersonalitySlotLike;
}

interface MemoryRowLike {
  content: { text?: string };
  metadata?: { category?: string; kind?: string; source?: string };
}

interface RuntimeLike {
  agentId: string;
  evaluators: EvaluatorLike[];
  providers: ProviderLike[];
  getService(name: string): unknown;
  getMemories(opts: {
    tableName: string;
    roomId: string;
    entityId?: string;
    limit?: number;
    unique?: boolean;
  }): Promise<MemoryRowLike[]>;
}

async function expectPreferenceLoopClosed(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeLike | undefined;
  if (!runtime) return "scenario runtime unavailable";
  if (!ctx.primaryRoomId || !ctx.primaryUserId) {
    return "executor did not expose primaryRoomId/primaryUserId to checks";
  }

  const evaluator = runtime.evaluators.find((e) => e.name === "preferences");
  if (!evaluator) {
    return "preferences evaluator is not registered on the runtime";
  }
  const processor = evaluator.processors?.[0];
  if (!processor) return "preferences evaluator has no processor";

  const store = runtime.getService(
    "PERSONALITY_STORE",
  ) as PersonalityStoreLike | null;
  if (!store) {
    return "PERSONALITY_STORE service is not registered (advancedCapabilities runtime expected)";
  }

  // Drive the processor with an already-parsed extraction — the deterministic
  // stand-in for the model's ops — against the real store and real facts table.
  const message = {
    id: crypto.randomUUID(),
    entityId: ctx.primaryUserId,
    agentId: runtime.agentId,
    roomId: ctx.primaryRoomId,
    content: {
      text: "ugh, that was way too long. also I like the dark background",
    },
    createdAt: Date.now(),
  };
  await processor.process({
    runtime,
    message,
    state: { values: {}, data: {}, text: "" },
    options: {},
    evaluatorName: "preferences",
    prepared: {
      recentMessages: [],
      slot: store.getSlot(ctx.primaryUserId),
      knownPreferenceFacts: [],
    },
    output: {
      ops: [
        {
          op: "set_trait",
          trait: "verbosity",
          value: "terse",
          confidence: 0.9,
        },
        {
          op: "add_preference_fact",
          claim: FACT_CLAIM,
          keywords: ["dark", "background", "theme"],
        },
      ],
    },
  });

  const slot = store.getSlot(ctx.primaryUserId);
  if (slot.verbosity !== "terse") {
    return `inferred trait never landed in the personality slot; verbosity=${String(slot.verbosity)}`;
  }
  if (slot.source !== "agent_inferred") {
    return `inferred write must carry agent_inferred provenance; source=${slot.source}`;
  }

  const facts = await runtime.getMemories({
    tableName: "facts",
    roomId: ctx.primaryRoomId,
    entityId: ctx.primaryUserId,
    limit: 20,
    unique: false,
  });
  const row = facts.find((fact) => fact.content.text === FACT_CLAIM);
  if (!row) {
    return `durable preference fact row never landed in the facts table; got ${facts.length} rows`;
  }
  if (
    row.metadata?.category !== "preference" ||
    row.metadata?.kind !== "durable" ||
    row.metadata?.source !== "preference_extractor"
  ) {
    return `preference fact row has wrong metadata: ${JSON.stringify(row.metadata)}`;
  }

  // Behavior-loop closure: the provider must re-inject the inferred trait
  // (with provenance) into the prompt context of the user's next message.
  const personality = runtime.providers.find(
    (p) => p.name === "userPersonalityPreferences",
  );
  if (!personality) {
    return "userPersonalityPreferences provider is not registered";
  }
  const rendered = await personality.get(
    runtime,
    {
      id: crypto.randomUUID(),
      entityId: ctx.primaryUserId,
      agentId: runtime.agentId,
      roomId: ctx.primaryRoomId,
      content: { text: "what should we do next?" },
      createdAt: Date.now(),
    },
    { values: {}, data: {}, text: "" },
  );
  if (!rendered.text.includes("verbosity: terse")) {
    return `inferred trait never reached the prompt; provider text: ${rendered.text || "(empty)"}`;
  }
  if (!rendered.text.includes("inferred from conversation")) {
    return `inferred provenance annotation missing from prompt; provider text: ${rendered.text}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-preference-extraction",
  lane: "pr-deterministic",
  title:
    "A passively extracted preference lands in the personality slot + facts table and re-enters the prompt",
  domain: "scenario-runner",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "preferences",
    "personality",
    "14675",
  ],
  status: "active",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Preference extraction loop",
    },
  ],
  seed: [],
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "preference extraction closes the behavior loop through real stores",
      predicate: expectPreferenceLoopClosed,
    },
  ],
});

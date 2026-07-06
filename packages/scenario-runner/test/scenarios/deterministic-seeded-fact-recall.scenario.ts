/**
 * Deterministic (keyless) proof for the #14631 seed pipeline: a plain-text
 * `type: "memory"` scenario seed must land as a REAL durable row in the
 * `facts` table and be surfaced by the core FACTS provider for the owner's
 * conversation. Before this pipeline existed, such seeds were silently
 * dropped — scenarios like `f1-adversarial-vip-misfile-cross-persona` graded
 * the model on a "seeded VIP fact" the model never received, which is how an
 * ambiguous possibly-VIP message could be confidently dismissed as junk.
 *
 * Runs zero turns: the assertion is on the seed → store → provider pipeline,
 * driven through the real runtime (real DB write, real FACTS retrieval and
 * render), no LLM calls.
 *
 * Fail-without-fix anchor: with the old no-op seedMemory the fact row never
 * exists, so the FACTS render check fails.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const SEEDED_FACT =
  "Owner fact: largest account is Halcyon Freight; their contact sometimes messages from a plain personal address with no signature.";

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

interface RuntimeLike {
  agentId: string;
  providers: ProviderLike[];
}

async function expectSeededFactSurfaced(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeLike | undefined;
  if (!runtime) return "scenario runtime unavailable";
  const facts = runtime.providers.find((p) => p.name === "FACTS");
  if (!facts) return "core FACTS provider is not registered on the runtime";
  if (!ctx.primaryRoomId || !ctx.primaryUserId) {
    return "executor did not expose primaryRoomId/primaryUserId to checks";
  }
  // The owner's triage ask from the live scenario this pipeline feeds: no
  // lexical overlap requirement — durable facts fall back to highest-prior
  // when keyword relevance misses.
  const result = await facts.get(
    runtime,
    {
      id: crypto.randomUUID(),
      entityId: ctx.primaryUserId,
      agentId: runtime.agentId,
      roomId: ctx.primaryRoomId,
      content: {
        text: "Quick triage: I got this with no subject from an address I don't recognize — is that anything or junk?",
      },
      createdAt: Date.now(),
    },
    { values: {}, data: {}, text: "" },
  );
  if (!result.text.includes("Halcyon Freight")) {
    return `seeded owner fact never reached the FACTS render; got: ${result.text || "(empty)"}`;
  }
  return undefined;
}

export default scenario({
  lane: "pr-deterministic",
  id: "deterministic-seeded-fact-recall",
  title:
    "A plain-text memory seed lands as a durable fact the FACTS provider surfaces",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "seeds", "facts", "14631"],
  status: "active",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Seeded fact recall",
    },
  ],
  seed: [
    {
      type: "memory",
      name: "seed that the owner's largest client is Halcyon Freight",
      content: { text: SEEDED_FACT },
    },
  ],
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "seeded owner fact surfaces through the real FACTS provider",
      predicate: expectSeededFactSurfaced,
    },
  ],
});

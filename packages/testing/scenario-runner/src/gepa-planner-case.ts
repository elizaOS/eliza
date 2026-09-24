/** Candidate-only planner boundary. No optimizer, promotion, or effect qualification is implied. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseOptimizedPromptArtifact } from "../../../../plugins/plugin-assistant/src/services/optimized-prompt.ts";
import { parseOptimizedPromptTargetBinding } from "../../../../plugins/plugin-assistant/src/services/optimized-prompt-provenance.ts";

export function gepaHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const generation = z
  .object({
    temperature: z.number().finite().min(0).max(2),
    maxTokens: z.number().int().positive(),
  })
  .strict();
const caseSchema = z
  .object({
    version: z.literal(1),
    caseId: z.string().min(1),
    scenarioFamily: z.string().min(1),
    variant: z.string().min(1),
    dynamic: z
      .object({
        userRequest: z.string(),
        history: z.array(z.json()),
        definitions: z.array(z.json()),
        toolResults: z.array(z.json()),
        viewCatalog: z.array(z.json()),
        providerContext: z.record(z.string(), z.json()),
      })
      .strict(),
    candidate: z.unknown(),
    target: z.unknown(),
    generation,
    // This is a declared fixture transport limit, not a claimed production-provider limit.
    maxRequestBytes: z.number().int().positive(),
  })
  .strict();

export function parseGepaPlannerCase(value: unknown) {
  const input = caseSchema.parse(value);
  const candidate = parseOptimizedPromptArtifact(input.candidate);
  const target = parseOptimizedPromptTargetBinding(input.target);
  if (candidate?.task !== "action_planner" || !candidate.provenance || !target)
    throw new Error(
      "A complete action_planner candidate and target binding are required",
    );
  const endpoint = new URL(target.endpoint);
  if (
    target.provider !== "deterministic-fixture" ||
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
  )
    throw new Error(
      "This worker admits only explicit loopback deterministic fixtures",
    );
  if (gepaHash(input.generation) !== target.generationConfigSha256)
    throw new Error(
      "Generation configuration does not match the declared target",
    );
  if (JSON.stringify(candidate.provenance.target) !== JSON.stringify(target))
    throw new Error("Candidate provenance does not match the declared target");
  return { ...input, candidate, target };
}
export type GepaPlannerCase = ReturnType<typeof parseGepaPlannerCase>;

/**
 * OCPlatform → Eliza migration orchestrator.
 *
 * Ties the pipeline together: read home → map character → tier memories →
 * assemble + (optionally) encrypt a `.eliza-agent` archive. Also supports the
 * sovereign-local path: emit the character JSON + memories JSONL for the
 * ELIZA_AGENT_CHARACTER_JSON env + /api/memory/remember seed flow.
 */

import { randomUUID } from "node:crypto";
import type { Character, Memory, UUID } from "@elizaos/core";
import { buildAgentArchive } from "./archive-writer.js";
import { type CharacterMapOptions, mapToCharacter } from "./character-mapper.js";
import { readOcAgentHome } from "./openclaw-reader.js";
import { type MemoryTier, tierMemories } from "./memory-tiering.js";

export interface MigrateOptions {
  /** OpenClaw agent home, e.g. ~/.moltbot. */
  from: string;
  /** Agent slug, e.g. "sol". */
  agentId: string;
  /** Days of daily logs to seed verbatim (T1 CURRENT). Default 14. */
  memoryDays?: number;
  /** Keep USER.md / personal knowledge OUT (portable archive). Default true. */
  firewall?: boolean;
  /** Optional live-context block for the character system prompt. */
  currentContext?: string;
}

export interface MigratePlan {
  character: Character;
  memories: Memory[];
  counts: Record<MemoryTier, number>;
  ids: { agentId: UUID; entityId: UUID; roomId: UUID };
  /** Quick provenance summary for dry-run output. */
  summary: {
    dailyLogsTotal: number;
    namedMemoryTotal: number;
    hasUser: boolean;
    firewalled: boolean;
    hasSecretsDir: boolean;
  };
}

/**
 * Build the full migration plan (character + tiered memories) without writing
 * anything. This is what `--dry-run` prints and what the archive/seed paths
 * consume. Deterministic except for the generated UUIDs.
 */
export function buildMigrationPlan(opts: MigrateOptions): MigratePlan {
  const firewall = opts.firewall ?? true;
  const src = readOcAgentHome(opts.from, opts.agentId);

  const mapOpts: CharacterMapOptions = {
    firewall,
    currentContext: opts.currentContext,
  };
  const character = mapToCharacter(src, mapOpts);

  const agentId = randomUUID() as UUID;
  const entityId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;

  const { memories, counts } = tierMemories(src, {
    memoryDays: opts.memoryDays ?? 14,
    roomId,
    entityId,
    agentId,
  });

  return {
    character,
    memories,
    counts,
    ids: { agentId, entityId, roomId },
    summary: {
      dailyLogsTotal: src.dailyLogs.length,
      namedMemoryTotal: src.namedMemory.length,
      hasUser: Boolean(src.user?.trim()),
      firewalled: firewall,
      hasSecretsDir: src.hasSecretsDir,
    },
  };
}

/**
 * Build an encrypted `.eliza-agent` archive buffer from a plan.
 */
export async function archiveFromPlan(
  plan: MigratePlan,
  sourceSlug: string,
  password: string,
): Promise<Buffer> {
  return buildAgentArchive(
    {
      agentId: plan.ids.agentId,
      sourceSlug,
      character: plan.character,
      entityId: plan.ids.entityId,
      roomId: plan.ids.roomId,
      memories: plan.memories,
    },
    password,
  );
}

/**
 * Emit the sovereign-local artifacts: a compact character JSON (for
 * ELIZA_AGENT_CHARACTER_JSON) and a JSONL of memory texts (for the
 * /api/memory/remember seed flow).
 */
export function emitSovereignArtifacts(plan: MigratePlan): {
  characterJson: string;
  memoriesJsonl: string;
} {
  const characterJson = JSON.stringify(plan.character);
  const memoriesJsonl = plan.memories
    .map((m) =>
      JSON.stringify({
        text: typeof m.content?.text === "string" ? m.content.text : "",
        tier: (m.metadata as { tier?: string } | undefined)?.tier,
      }),
    )
    .join("\n");
  return { characterJson, memoriesJsonl };
}

// Re-export the building blocks for direct use + testing.
export { assemblePayload } from "./archive-writer.js";
export { mapToCharacter } from "./character-mapper.js";
export { readOcAgentHome } from "./ocplatform-reader.js";
export { tierMemories } from "./memory-tiering.js";

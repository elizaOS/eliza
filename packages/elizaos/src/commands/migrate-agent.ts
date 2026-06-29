/**
 * `elizaos migrate-agent` - migrate a file-based OCPlatform agent onto Eliza.
 *
 * Reads an OpenClaw agent home (SOUL/IDENTITY/USER/AGENTS/TOOLS + memory/),
 * maps it to an Eliza Character + recency-tiered memories, and emits either:
 *   - a portable encrypted `.eliza-agent` archive (--out, consumed by importAgent), or
 *   - sovereign-local artifacts: character JSON + memories JSONL (--emit-*).
 *
 * Personal context (USER.md) is firewalled out of portable archives by default.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  archiveFromPlan,
  buildMigrationPlan,
  emitSovereignArtifacts,
  type MigratePlan,
} from "../migrate/index.js";

export interface MigrateAgentOptions {
  from?: string;
  agentId?: string;
  out?: string;
  password?: string;
  memoryDays?: string;
  firewall?: boolean;
  noFirewall?: boolean;
  currentContext?: string;
  emitCharacter?: string;
  emitMemories?: string;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * In --json mode stdout must be PURE machine-parseable JSON, so all human-
 * facing chrome (intro/outro/notes/logs) routes to stderr instead of clack's
 * stdout writers. `quiet` is set true when opts.json is on.
 */
let quiet = false;

function fail(msg: string): never {
  if (quiet) {
    process.stderr.write(`${msg}\n`);
  } else {
    clack.cancel(msg);
  }
  process.exit(1);
}

function printPlan(plan: MigratePlan, slug: string): void {
  const c = plan.counts;
  clack.note(
    [
      `agent:           ${pc.bold(plan.character.name ?? slug)}`,
      `system prompt:   ${(plan.character.system ?? "").length} chars`,
      `bio lines:       ${plan.character.bio?.length ?? 0}`,
      `style.chat:      ${plan.character.style?.chat?.length ?? 0} hints`,
      `knowledge:       ${plan.character.knowledge?.length ?? 0} (firewalled=${plan.summary.firewalled})`,
      "",
      `memories total:  ${plan.memories.length}`,
      `  CURRENT:       ${c.CURRENT}`,
      `  LONGTERM:      ${c.LONGTERM}`,
      `  SELF:          ${c.SELF}`,
      `  older marker:  ${c.MARKER}`,
      `  dedup dropped: ${plan.summary.duplicatesDropped}`,
      `  clipped:       ${plan.summary.clipped} (truncated at maxChunkLen)`,
      "",
      `daily logs seen: ${plan.summary.dailyLogsTotal}`,
      `named memory:    ${plan.summary.namedMemoryTotal}`,
      `USER.md present: ${plan.summary.hasUser}`,
      `secrets dir:     ${plan.summary.hasSecretsDir} (not read - firewalled)`,
    ].join("\n"),
    "Migration plan",
  );
}

export async function migrateAgent(opts: MigrateAgentOptions): Promise<void> {
  // Set quiet BEFORE any validation that can fail(), so --json runs keep stdout
  // machine-parseable even when an early validation error is raised.
  quiet = Boolean(opts.json);

  const from = opts.from?.trim();
  const agentId = opts.agentId?.trim();
  if (!from) fail("--from <ocplatform-home> is required (e.g. ~/.moltbot).");
  if (!agentId) fail("--agent-id <slug> is required (e.g. sol).");
  const sourceHome = from;
  const sourceAgentId = agentId;
  if (!fs.existsSync(sourceHome)) fail(`Home not found: ${sourceHome}`);

  const firewall = opts.noFirewall ? false : (opts.firewall ?? true);
  const memoryDays = opts.memoryDays ? Number(opts.memoryDays) : 14;
  if (Number.isNaN(memoryDays) || memoryDays < 0) {
    fail("--memory-days must be a non-negative number.");
  }

  if (!quiet) clack.intro(pc.cyan(`migrate-agent: ${sourceAgentId}`));

  const plan = buildMigrationPlan({
    from: sourceHome,
    agentId: sourceAgentId,
    memoryDays,
    firewall,
    currentContext: opts.currentContext,
  });

  // Surface any reader warnings (sqlite-not-ported, empty-home, etc). These
  // always go to stderr so --json stdout stays clean.
  for (const w of plan.summary.warnings ?? []) {
    process.stderr.write(`warning: ${w}\n`);
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          character: plan.character,
          counts: plan.counts,
          summary: plan.summary,
          memoryCount: plan.memories.length,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  printPlan(plan, sourceAgentId);

  if (opts.dryRun) {
    if (!quiet) clack.outro(pc.dim("dry-run: nothing written."));
    return;
  }

  // ---- sovereign-local artifacts (character JSON + memories JSONL) ----
  if (opts.emitCharacter || opts.emitMemories) {
    const { characterJson, memoriesJsonl } = emitSovereignArtifacts(plan);
    if (opts.emitCharacter) {
      fs.mkdirSync(path.dirname(path.resolve(opts.emitCharacter)), {
        recursive: true,
      });
      fs.writeFileSync(opts.emitCharacter, characterJson);
      clack.log.success(`character → ${opts.emitCharacter}`);
    }
    if (opts.emitMemories) {
      fs.mkdirSync(path.dirname(path.resolve(opts.emitMemories)), {
        recursive: true,
      });
      fs.writeFileSync(opts.emitMemories, memoriesJsonl);
      clack.log.success(
        `memories (${plan.memories.length}) → ${opts.emitMemories}`,
      );
    }
  }

  // ---- portable encrypted archive ----
  if (opts.out) {
    const password = opts.password?.trim();
    if (!password || password.length < 8) {
      fail(
        "--password (min 8 chars) is required to write an encrypted --out archive.",
      );
    }
    const archivePassword = password;
    if (!firewall) {
      clack.log.warn(
        pc.yellow(
          "Firewall DISABLED: USER/personal knowledge is INCLUDED in this archive. " +
            "Do not share it.",
        ),
      );
    }
    const buf = await archiveFromPlan(plan, sourceAgentId, archivePassword);
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, buf);
    clack.log.success(`archive → ${opts.out} (${buf.length} bytes)`);
    clack.log.info(
      pc.dim("import with: importAgent(runtime, fileBuffer, password)"),
    );
  }

  if (!opts.out && !opts.emitCharacter && !opts.emitMemories) {
    clack.log.warn(
      "No output requested. Use --out <archive>, --emit-character, --emit-memories, or --dry-run.",
    );
  }

  if (!quiet) clack.outro(pc.green("migrate-agent done."));
}

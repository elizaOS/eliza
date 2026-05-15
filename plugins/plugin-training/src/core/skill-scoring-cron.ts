/**
 * Nightly skill-scoring cron job.
 *
 * For every curated skill (active + disabled), pull the most recent
 * trajectories that referenced the skill, run `scoreSkill`, and rewrite the
 * SKILL.md frontmatter with the new `provenance.lastEvalScore`.
 *
 * The job is registered via the runtime cron/Task scheduling path at agent boot.
 * Failure to compute a score for a single skill never aborts the
 * batch — we surface per-skill errors via the logger and continue.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "@elizaos/core";
import {
  type CronServiceLike,
  ensureNamedCronJob,
  registerRuntimeEventOnce,
} from "./ensure-cron-job.js";
import { type ScoreableTrajectory, scoreSkill } from "./replay-validator.js";
import { waitForService } from "./wait-for-service.js";

interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
}

interface RuntimeLike {
  getService: (name: string) => unknown;
  logger?: MinimalLogger;
  registerEvent?: (
    name: string,
    handler: (payload: unknown) => Promise<void>,
  ) => void;
}

interface TrajectoryServiceLike {
  listTrajectories: (options: {
    limit?: number;
  }) => Promise<{ trajectories: Array<{ id: string }> }>;
  getTrajectoryDetail: (id: string) => Promise<ScoreableTrajectory | null>;
}

const SCORE_EVENT_NAME = "TRACK_C_SKILL_SCORE";
const DEFAULT_TRAJECTORY_LIMIT = 200;

function curatedActiveDir(): string {
  return join(resolveStateDir(), "skills", "curated", "active");
}

function listCuratedSkillFiles(): Array<{ name: string; path: string }> {
  const dir = curatedActiveDir();
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (existsSync(file)) {
      out.push({ name: entry.name, path: file });
    }
  }
  return out;
}

/**
 * Rewrite a SKILL.md file's `provenance.lastEvalScore` field in place.
 *
 * Implemented as a targeted text replacement to preserve the rest of the
 * frontmatter exactly (no YAML round-trip). Adds `lastEvalScore` to the
 * provenance block when the field is missing.
 */
export function applyScoreToSkillFile(
  filePath: string,
  score: number,
): boolean {
  const content = readFileSync(filePath, "utf-8");
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return false;
  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx === -1) return false;
  const yamlBlock = normalized.slice(4, endIdx);
  const tail = normalized.slice(endIdx);
  const lines = yamlBlock.split("\n");

  const provenanceIdx = lines.findIndex((line) =>
    /^provenance:\s*$/.test(line.trimEnd()),
  );
  const formattedScore = score.toFixed(4);

  if (provenanceIdx === -1) {
    // Append a minimal provenance block.
    const created = new Date().toISOString();
    lines.push(
      "provenance:",
      "  source: human",
      `  createdAt: ${created}`,
      "  refinedCount: 0",
      `  lastEvalScore: ${formattedScore}`,
    );
  } else {
    let endOfBlock = lines.length;
    for (let i = provenanceIdx + 1; i < lines.length; i++) {
      if (!/^\s/.test(lines[i] ?? "")) {
        endOfBlock = i;
        break;
      }
    }
    let updated = false;
    for (let i = provenanceIdx + 1; i < endOfBlock; i++) {
      const line = lines[i] ?? "";
      if (/^\s+lastEvalScore\s*:/.test(line)) {
        lines[i] = `  lastEvalScore: ${formattedScore}`;
        updated = true;
        break;
      }
    }
    if (!updated) {
      lines.splice(endOfBlock, 0, `  lastEvalScore: ${formattedScore}`);
    }
  }

  const rebuilt = `---\n${lines.join("\n")}${tail}`;
  writeFileSync(filePath, rebuilt, "utf-8");
  return true;
}

/**
 * Score every curated active skill against the most recent trajectories from
 * the runtime's trajectory store. Returns a per-skill report (kept small so
 * tests can assert on it).
 */
export async function runSkillScoringBatch(
  runtime: RuntimeLike,
  options?: { trajectoryLimit?: number },
): Promise<
  Array<{ name: string; score: number; updated: boolean; error?: string }>
> {
  const log: MinimalLogger = runtime.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const trajectoryService = runtime.getService(
    "trajectories",
  ) as TrajectoryServiceLike | null;
  if (
    !trajectoryService ||
    typeof trajectoryService.listTrajectories !== "function" ||
    typeof trajectoryService.getTrajectoryDetail !== "function"
  ) {
    log.warn("[SkillScoringCron] trajectories service unavailable; skipping");
    return [];
  }

  const limit = options?.trajectoryLimit ?? DEFAULT_TRAJECTORY_LIMIT;
  const list = await trajectoryService.listTrajectories({ limit });
  const trajectories: ScoreableTrajectory[] = [];
  for (const item of list.trajectories ?? []) {
    const detail = await trajectoryService.getTrajectoryDetail(item.id);
    if (detail) trajectories.push(detail);
  }

  const skills = listCuratedSkillFiles();
  const results: Array<{
    name: string;
    score: number;
    updated: boolean;
    error?: string;
  }> = [];
  for (const skill of skills) {
    const score = await scoreSkill({ name: skill.name }, trajectories);
    let updated = false;
    let errorMessage: string | undefined;
    try {
      updated = applyScoreToSkillFile(skill.path, score);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `[SkillScoringCron] failed to update score for "${skill.name}": ${errorMessage}`,
      );
    }
    results.push({
      name: skill.name,
      score,
      updated,
      error: errorMessage,
    });
  }
  log.info(
    `[SkillScoringCron] scored ${results.length} curated skills against ${trajectories.length} trajectories`,
  );
  return results;
}

/**
 * Register the nightly skill-scoring cron job + event handler against the
 * agent runtime. Safe to call multiple times — we reuse any existing job and
 * prune duplicate persisted registrations by name.
 *
 * Schedule defaults to "5 3 * * *" (03:05 local time) so it runs after the
 * trajectory-export cron (which runs at 03:00).
 */
export async function registerSkillScoringCron(
  runtime: RuntimeLike,
  options?: { schedule?: string; tz?: string },
): Promise<void> {
  const log: MinimalLogger = runtime.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const cronService = await waitForService<CronServiceLike>(runtime, "CRON", {
    timeoutMs: 2_000,
  });
  if (!cronService || typeof cronService.createJob !== "function") {
    log.debug(
      `[SkillScoringCron] CRON service not registered; cron not scheduled (run on-demand via ${SCORE_EVENT_NAME} event)`,
    );
    return;
  }
  registerRuntimeEventOnce(runtime, SCORE_EVENT_NAME, async () => {
    await runSkillScoringBatch(runtime);
  });
  const registration = await ensureNamedCronJob(
    cronService,
    {
      name: "track-c-skill-scoring-nightly",
      description: "Nightly evaluation of curated agent skills",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: options?.schedule ?? "5 3 * * *",
        tz: options?.tz,
      },
      payload: {
        kind: "event",
        eventName: SCORE_EVENT_NAME,
      },
      metadata: { trackC: true, kind: "skill-scoring" },
    },
    { log, logPrefix: "[SkillScoringCron]" },
  );
  log.info(
    registration === "created"
      ? "[SkillScoringCron] registered nightly skill-scoring cron"
      : "[SkillScoringCron] using existing nightly skill-scoring cron",
  );
}

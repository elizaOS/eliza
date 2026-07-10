/**
 * Durable per-account collector checkpoints. A 2-year backfill must survive
 * interruption and rerun idempotently, so each collector records the high-water
 * mark of what it has already emitted (the newest source timestamp and the last
 * seen source id) and resumes strictly forward from it. The store is a plain
 * JSON file under the collector's local `.state` dir — never the git tree — and
 * is written atomically (temp + rename) so a crash mid-write cannot leave a
 * half-written checkpoint that would silently skip or re-emit messages.
 *
 * Consumed by every `src/collectors/*` collector; the shape is intentionally
 * platform-neutral so resume semantics stay identical across Gmail, Telegram,
 * Discord, iMessage, Signal, and X.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CorpusPlatform } from "../schema.ts";

export const collectorCheckpointSchema = z.object({
  platform: z.string().min(1),
  accountId: z.string().min(1),
  // Newest source timestamp (ms since epoch) already written to a shard. The
  // next run pulls strictly greater-than this to avoid re-emitting the boundary
  // message while never skipping a gap.
  lastTs: z.number().int().nonnegative(),
  // Newest source-native id at `lastTs`, used to break ties when two messages
  // share a millisecond so a resume neither drops nor duplicates them.
  lastId: z.string().min(1).optional(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
});

export type CollectorCheckpoint = z.infer<typeof collectorCheckpointSchema>;

function checkpointPath(
  stateDir: string,
  platform: CorpusPlatform,
  accountId: string,
): string {
  const safeAccount = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(stateDir, platform, `${safeAccount}.checkpoint.json`);
}

/**
 * Load an account's checkpoint, or `null` on a first run. A checkpoint file that
 * exists but fails the schema is a corrupted resume marker, not an empty one:
 * we throw so the collector fails closed rather than silently restarting a
 * multi-hour backfill from zero and duplicating everything.
 */
export async function readCheckpoint(
  stateDir: string,
  platform: CorpusPlatform,
  accountId: string,
): Promise<CollectorCheckpoint | null> {
  const file = checkpointPath(stateDir, platform, accountId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // error-policy:J3 checkpoint file is untrusted on-disk state; a parse/schema
  // failure is a corrupted marker and must fail closed, never reset to zero.
  const parsed = collectorCheckpointSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `corrupt checkpoint at ${file}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function writeCheckpoint(
  stateDir: string,
  checkpoint: CollectorCheckpoint,
): Promise<void> {
  const validated = collectorCheckpointSchema.parse(checkpoint);
  const file = checkpointPath(
    stateDir,
    validated.platform as CorpusPlatform,
    validated.accountId,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

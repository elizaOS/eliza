import { createHash } from "node:crypto";

export interface QuintShard {
  index: number;
  count: number;
}

/** Stable across hosts and independent of directory traversal order. */
export function quintShardForFile(file: string, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) {
    throw new Error("Quint shard count must be an integer from 1 to 64");
  }
  const digest = createHash("sha256")
    .update(file.replaceAll("\\", "/"))
    .digest();
  return (digest.readUInt32BE(0) % count) + 1;
}

export function parseQuintShard(argument: string): QuintShard {
  const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(argument);
  if (!match)
    throw new Error("Use --shard=<index>/<count>, with one-based indices");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    count > 64 ||
    index > count
  ) {
    throw new Error("Quint shard must satisfy 1 <= index <= count <= 64");
  }
  return { index, count };
}

export function selectQuintShard<T extends { file: string }>(
  models: T[],
  shard: QuintShard,
): T[] {
  parseQuintShard(`--shard=${shard.index}/${shard.count}`);
  return models.filter(
    (model) => quintShardForFile(model.file, shard.count) === shard.index,
  );
}

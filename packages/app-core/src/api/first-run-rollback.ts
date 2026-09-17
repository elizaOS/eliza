/**
 * Reverts only configuration values still owned by a failed first-run commit.
 * Each successful write records its actual input and output; reverse comparison
 * preserves later edits, including siblings added inside newly created objects.
 */
import { isDeepStrictEqual } from "node:util";
import {
  isDevCloudEnvOwnedKey,
  isDevCloudInternalEnvKey,
} from "@elizaos/agent/config/dev-cloud-env-authority";
import type { ElizaConfig } from "@elizaos/shared";
import { resolveDevCloudEnvAuthority } from "@elizaos/shared";

export type FirstRunConfigWriteObserver = (
  before: ElizaConfig,
  after: ElizaConfig,
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifiedRecordArray(
  value: unknown,
): value is (Record<string, unknown> & { id: string })[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || ids.has(entry.id))
      return false;
    ids.add(entry.id);
    return true;
  });
}

function restoreFields(
  current: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      continue;
    const hadBefore = Object.hasOwn(before, key);
    const hadAfter = Object.hasOwn(after, key);
    if (hadBefore === hadAfter && isDeepStrictEqual(before[key], after[key]))
      continue;
    const value = current[key];
    const previous = before[key];
    const written = after[key];
    if (
      isRecord(value) &&
      isRecord(written) &&
      (!hadBefore || isRecord(previous))
    ) {
      restoreFields(value, isRecord(previous) ? previous : {}, written);
      if (!hadBefore && Object.keys(value).length === 0) delete current[key];
    } else if (
      isIdentifiedRecordArray(value) &&
      isIdentifiedRecordArray(previous) &&
      isIdentifiedRecordArray(written) &&
      previous.length === written.length &&
      previous.every((entry) =>
        written.some((candidate) => candidate.id === entry.id),
      )
    ) {
      // First-run updates an existing agent by identity. Concurrent inserts,
      // removals and reordering belong to their writer and remain intact.
      const priorEntries = new Map(previous.map((entry) => [entry.id, entry]));
      const writtenEntries = new Map(written.map((entry) => [entry.id, entry]));
      for (const entry of value) {
        const priorEntry = priorEntries.get(entry.id);
        const writtenEntry = writtenEntries.get(entry.id);
        if (priorEntry && writtenEntry)
          restoreFields(entry, priorEntry, writtenEntry);
      }
    } else if (
      Object.hasOwn(current, key) === hadAfter &&
      isDeepStrictEqual(value, written)
    ) {
      if (hadBefore) current[key] = structuredClone(previous);
      else delete current[key];
    }
  }
}

export class FirstRunConfigRollback {
  private readonly environmentWrites: {
    key: string;
    previous: string | undefined;
    written: string | undefined;
  }[] = [];

  readonly observeEnvironmentMutation = <T>(mutation: () => T): T => {
    const before = { ...process.env };
    const authority = resolveDevCloudEnvAuthority();
    try {
      return mutation();
    } finally {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(process.env),
      ])) {
        if (
          isDevCloudInternalEnvKey(key) ||
          (authority && isDevCloudEnvOwnedKey(key))
        )
          continue;
        if (before[key] !== process.env[key])
          this.environmentWrites.push({
            key,
            previous: before[key],
            written: process.env[key],
          });
      }
    }
  };

  restoreEnvironment(): void {
    for (const write of [...this.environmentWrites].reverse()) {
      if (process.env[write.key] !== write.written) continue;
      if (write.previous === undefined) delete process.env[write.key];
      else process.env[write.key] = write.previous;
    }
  }

  private readonly writes: { before: ElizaConfig; after: ElizaConfig }[] = [];

  get hasWrites(): boolean {
    return this.writes.length > 0;
  }

  readonly record: FirstRunConfigWriteObserver = (before, after) => {
    this.writes.push({
      before: structuredClone(before),
      after: structuredClone(after),
    });
  };

  restore(config: ElizaConfig): ElizaConfig {
    const restored = structuredClone(config);
    for (const write of [...this.writes].reverse()) {
      restoreFields(
        restored as Record<string, unknown>,
        write.before as Record<string, unknown>,
        write.after as Record<string, unknown>,
      );
    }
    return restored;
  }
}

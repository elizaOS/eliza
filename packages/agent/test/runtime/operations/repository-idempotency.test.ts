/**
 * Verifies filesystem-backed runtime-operation pruning releases only the
 * idempotency binding owned by the operation being removed.
 */

import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository.js";
import type { RuntimeOperation } from "../../../src/runtime/operations/types.js";

const HOUR_MS = 60 * 60 * 1000;

let stateDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

function operation(
  id: string,
  startedAt: number,
  idempotencyKey: string,
): RuntimeOperation {
  return {
    id,
    kind: "provider-switch",
    intent: { kind: "provider-switch", provider: "openai" },
    tier: "hot",
    idempotencyKey,
    status: "succeeded",
    phases: [],
    startedAt,
    finishedAt: startedAt,
  };
}

async function persistOperations(
  operations: RuntimeOperation[],
): Promise<string> {
  stateDir = await fs.mkdtemp(join(tmpdir(), "runtime-ops-idempotency-"));
  const operationsDir = join(stateDir, "runtime-operations");
  await fs.mkdir(operationsDir);
  await Promise.all(
    operations.map((op) =>
      fs.writeFile(
        join(operationsDir, `${op.id}.json`),
        `${JSON.stringify(op)}\n`,
      ),
    ),
  );
  return operationsDir;
}

describe("FilesystemRuntimeOperationRepository idempotency pruning", () => {
  test("pruning an old operation preserves the current operation's reused key", async () => {
    const now = Date.now();
    const idempotencyKey = "cli-switch-openai";
    const oldOperation = operation(
      "old-operation",
      now - 30 * HOUR_MS,
      idempotencyKey,
    );
    const currentOperation = operation(
      "current-operation",
      now,
      idempotencyKey,
    );
    const operationsDir = await persistOperations([
      oldOperation,
      currentOperation,
    ]);
    vi.spyOn(fs, "readdir").mockResolvedValue([
      `${oldOperation.id}.json`,
      `${currentOperation.id}.json`,
    ] as never);
    const repository = new FilesystemRuntimeOperationRepository(stateDir, {
      retentionMs: 7 * 24 * HOUR_MS,
      maxRecords: 1,
    });

    expect(await repository.get(oldOperation.id)).toBeNull();
    await expect(
      fs.access(join(operationsDir, `${oldOperation.id}.json`)),
    ).rejects.toThrow();
    await fs.access(join(operationsDir, `${currentOperation.id}.json`));
    expect(await repository.findByIdempotencyKey(idempotencyKey)).toEqual(
      currentOperation,
    );
  });

  test("pruning the binding owner deletes its idempotency entry", async () => {
    const now = Date.now();
    const idempotencyKey = "cli-switch-anthropic";
    const oldOperation = operation(
      "owned-operation",
      now - 30 * HOUR_MS,
      idempotencyKey,
    );
    const operationsDir = await persistOperations([oldOperation]);
    vi.spyOn(fs, "readdir").mockResolvedValue([
      `${oldOperation.id}.json`,
    ] as never);
    const mapDelete = vi.spyOn(Map.prototype, "delete");
    const repository = new FilesystemRuntimeOperationRepository(stateDir, {
      retentionMs: 7 * 24 * HOUR_MS,
      maxRecords: 0,
    });

    expect(await repository.get(oldOperation.id)).toBeNull();
    expect(mapDelete).toHaveBeenCalledWith(idempotencyKey);
    expect(await repository.findByIdempotencyKey(idempotencyKey)).toBeNull();
    await expect(
      fs.access(join(operationsDir, `${oldOperation.id}.json`)),
    ).rejects.toThrow();
  });
});

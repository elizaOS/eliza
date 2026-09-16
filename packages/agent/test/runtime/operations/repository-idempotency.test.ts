/** Exercises reused runtime-operation keys through real filesystem hydration, pruning and restart. */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository";
import type { RuntimeOperation } from "../../../src/runtime/operations/types";

const directories: string[] = [];
const HOUR = 3_600_000;
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
function operation(id: string, startedAt: number): RuntimeOperation {
  return {
    id,
    startedAt,
    finishedAt: startedAt,
    kind: "provider-switch",
    intent: { kind: "provider-switch", provider: "openai" },
    tier: "hot",
    idempotencyKey: "reused-key",
    status: "succeeded",
    phases: [],
  };
}
async function persist(ops: RuntimeOperation[]): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "runtime-key-order-"));
  directories.push(dir);
  await fs.mkdir(join(dir, "runtime-operations"));
  for (const op of ops)
    await fs.writeFile(
      join(dir, "runtime-operations", `${op.id}.json`),
      JSON.stringify(op),
    );
  return dir;
}

describe("runtime operation key ownership", () => {
  for (const currentFirst of [true, false]) {
    for (const maxRecords of [1, 100]) {
      it(`retains the current key across hydration and restart: currentFirst=${currentFirst}, maxRecords=${maxRecords}`, async () => {
        const now = Date.now();
        const current = operation(
          currentFirst ? "a-current" : "z-current",
          now,
        );
        const old = operation(
          currentFirst ? "z-old" : "a-old",
          now - 30 * HOUR,
        );
        const dir = await persist(
          currentFirst ? [current, old] : [old, current],
        );
        for (let restart = 0; restart < 2; restart++) {
          const repository = new FilesystemRuntimeOperationRepository(dir, {
            maxRecords,
          });
          expect(await repository.findByIdempotencyKey("reused-key")).toEqual(
            current,
          );
          expect(await repository.get(current.id)).toEqual(current);
        }
        const files = await fs.readdir(join(dir, "runtime-operations"));
        expect(files.includes(`${old.id}.json`)).toBe(maxRecords > 1);
        expect(
          JSON.parse(
            await fs.readFile(
              join(dir, "runtime-operations", `${current.id}.json`),
              "utf8",
            ),
          ),
        ).toEqual(current);
      });
    }
  }
  it("does not let freshly reaped old work replace a newer key", async () => {
    const now = Date.now();
    const current = operation("a-current", now);
    const old: RuntimeOperation = {
      ...operation("z-old", now - 30 * HOUR),
      status: "running",
      finishedAt: undefined,
    };
    const dir = await persist([current, old]);
    const repository = new FilesystemRuntimeOperationRepository(dir);
    expect(await repository.findByIdempotencyKey("reused-key")).toEqual(
      current,
    );
    expect((await repository.get(old.id))?.status).toBe("failed");
    expect(
      await new FilesystemRuntimeOperationRepository(dir).findByIdempotencyKey(
        "reused-key",
      ),
    ).toEqual(current);
  });
  it("preserves a rebound key during post-create pruning", async () => {
    const now = Date.now();
    const old = operation("old", now - 30 * HOUR);
    const current = operation("current", now);
    const dir = await persist([old]);
    const repository = new FilesystemRuntimeOperationRepository(dir, {
      maxRecords: 1,
    });
    expect(await repository.findByIdempotencyKey("reused-key")).toBeNull();
    await repository.create(current);
    await repository.pruneTerminal();
    expect(await repository.get(old.id)).toBeNull();
    expect(await repository.findByIdempotencyKey("reused-key")).toEqual(
      current,
    );
    expect(
      await new FilesystemRuntimeOperationRepository(dir).findByIdempotencyKey(
        "reused-key",
      ),
    ).toEqual(current);
  });
  it("removes a pruned key owner without resurrecting an expired operation", async () => {
    const dir = await persist([operation("old", Date.now() - 30 * HOUR)]);
    const repository = new FilesystemRuntimeOperationRepository(dir, {
      maxRecords: 0,
    });
    expect(await repository.findByIdempotencyKey("reused-key")).toBeNull();
    expect(await repository.get("old")).toBeNull();
    expect(await fs.readdir(join(dir, "runtime-operations"))).toEqual([]);
  });
  it("rejects ambiguous persisted ownership instead of selecting by filename", async () => {
    const now = Date.now();
    const dir = await persist([
      operation("first", now),
      operation("second", now),
    ]);
    const repository = new FilesystemRuntimeOperationRepository(dir);
    await expect(
      repository.findByIdempotencyKey("reused-key"),
    ).rejects.toMatchObject({
      code: "RUNTIME_OPERATION_IDEMPOTENCY_AMBIGUOUS",
    });
    expect((await fs.readdir(join(dir, "runtime-operations"))).length).toBe(2);
  });
  for (const distinguishedPosition of [0, 1, 2]) {
    it(`ignores an old tie when the newer owner is in position ${distinguishedPosition}`, async () => {
      const now = Date.now();
      const ops = [0, 1, 2].map((position) =>
        operation(
          `record-${position}`,
          position === distinguishedPosition ? now : now - 30 * HOUR,
        ),
      );
      const dir = await persist(ops);
      const repository = new FilesystemRuntimeOperationRepository(dir);
      expect(await repository.findByIdempotencyKey("reused-key")).toEqual(
        ops[distinguishedPosition],
      );
      expect(
        await new FilesystemRuntimeOperationRepository(
          dir,
        ).findByIdempotencyKey("reused-key"),
      ).toEqual(ops[distinguishedPosition]);
    });
    it(`rejects a newest-owner tie with older work in position ${distinguishedPosition}`, async () => {
      const now = Date.now();
      const ops = [0, 1, 2].map((position) =>
        operation(
          `record-${position}`,
          position === distinguishedPosition ? now - 30 * HOUR : now,
        ),
      );
      const dir = await persist(ops);
      await expect(
        new FilesystemRuntimeOperationRepository(dir).findByIdempotencyKey(
          "reused-key",
        ),
      ).rejects.toMatchObject({
        code: "RUNTIME_OPERATION_IDEMPOTENCY_AMBIGUOUS",
      });
    });
  }
});

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileReleaseSequenceStore } from "../release-sequence-store";

const roots: string[] = [];

async function storeFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "eliza-sequence-test-"));
  roots.push(root);
  const statePath = path.join(root, "release-sequences.json");
  return { statePath, store: new FileReleaseSequenceStore(statePath) };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("release sequence rollback store", () => {
  it("accepts equal/newer sequences and atomically rejects rollback", async () => {
    const { statePath, store } = await storeFixture();
    await store.accept({ "stable/x86_64": 42 });
    await store.accept({ "stable/x86_64": 42 });
    await store.accept({ "stable/x86_64": 43, "stable/arm64": 7 });
    await expect(store.accept({ "stable/x86_64": 41 })).rejects.toThrow(
      "rollback rejected",
    );

    await expect(fs.readFile(statePath, "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        sequences: { "stable/x86_64": 43, "stable/arm64": 7 },
      })}\n`,
    );
    await expect(fs.readdir(path.dirname(statePath))).resolves.toEqual([
      "release-sequences.json",
    ]);
  });

  it("fails closed on corrupt or invalid persisted state", async () => {
    const { statePath, store } = await storeFixture();
    await fs.writeFile(statePath, "not json", { mode: 0o600 });
    await expect(store.accept({ "stable/x86_64": 1 })).rejects.toThrow(
      "corrupt JSON",
    );

    await fs.writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 1, sequences: { arbitrary: 99 } }),
    );
    await expect(store.accept({ "stable/x86_64": 1 })).rejects.toThrow(
      "invalid entry",
    );
  });

  it("serializes concurrent updates in one process", async () => {
    const { statePath, store } = await storeFixture();
    await Promise.all([
      store.accept({ "nightly/riscv64": 10 }),
      store.accept({ "nightly/riscv64": 11 }),
    ]);
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sequences: Record<string, number>;
    };
    expect(state.sequences["nightly/riscv64"]).toBe(11);
  });

  it("fails closed when another process holds the atomic state lock", async () => {
    const { statePath, store } = await storeFixture();
    await fs.mkdir(`${statePath}.lock`);
    await expect(store.accept({ "stable/x86_64": 1 })).rejects.toThrow(
      "locked by another installer process",
    );
    await fs.rmdir(`${statePath}.lock`);
    await expect(store.accept({ "stable/x86_64": 1 })).resolves.toBeUndefined();
  });
});

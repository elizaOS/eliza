import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReleaseSequenceStore } from "../release-sequence-store";

const roots: string[] = [];

async function storeFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "eliza-sequence-test-"));
  roots.push(root);
  const statePath = path.join(root, "release-sequences.json");
  return { statePath, store: new FileReleaseSequenceStore(statePath) };
}

afterEach(async () => {
  vi.restoreAllMocks();
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

  it("persists the authenticated sequence even if its caller mutates the input", async () => {
    const { statePath, store } = await storeFixture();
    const candidate = { "stable/x86_64": 42 };
    const accepted = store.accept(candidate);
    candidate["stable/x86_64"] = 1;
    await accepted;
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.sequences["stable/x86_64"]).toBe(42);
    await expect(store.accept({ "stable/x86_64": 2 })).rejects.toThrow(
      "rollback rejected",
    );
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

  it("preserves write and cleanup failures while attempting every cleanup", async () => {
    const { statePath, store } = await storeFixture();
    const realOpen = fs.open.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    const writeFailure = new Error("write failed");
    const closeFailure = new Error("close failed");
    const unlinkFailure = new Error("unlink failed");
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        vi.spyOn(handle, "writeFile").mockRejectedValue(writeFailure);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw closeFailure;
        });
      }
      return handle;
    });
    const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      await realUnlink(file);
      throw unlinkFailure;
    });
    const failure = await store
      .accept({ "stable/x86_64": 42 })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "ELIZAOS_RELEASE_SEQUENCE_RECOVERY_REQUIRED",
      cause: { errors: [writeFailure, closeFailure, unlinkFailure] },
    });
    expect(unlink).toHaveBeenCalledOnce();
    expect(await fs.readdir(path.dirname(statePath))).toEqual([
      "release-sequences.json.lock",
    ]);
  });

  it("retains the lock when directory sync fails after publishing state", async () => {
    const { statePath, store } = await storeFixture();
    const realOpen = fs.open.bind(fs);
    const syncFailure = new Error("injected directory sync failure");
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === path.dirname(statePath)) {
        vi.spyOn(handle, "sync").mockRejectedValue(syncFailure);
      }
      return handle;
    });
    await expect(store.accept({ "stable/x86_64": 42 })).rejects.toMatchObject({
      code: "ELIZAOS_RELEASE_SEQUENCE_RECOVERY_REQUIRED",
      cause: syncFailure,
    });
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.sequences["stable/x86_64"]).toBe(42);
    vi.restoreAllMocks();
    // Both this instance and a restarted process must refuse the uncertain state.
    await expect(store.accept({ "stable/x86_64": 42 })).rejects.toThrow(
      "state is locked",
    );
    await expect(
      new FileReleaseSequenceStore(statePath).accept({ "stable/x86_64": 43 }),
    ).rejects.toThrow("state is locked");
    expect((await fs.stat(`${statePath}.lock`)).isDirectory()).toBe(true);
  });

  it("fails closed when another process holds the atomic state lock", async () => {
    const { statePath, store } = await storeFixture();
    await fs.mkdir(`${statePath}.lock`);
    await expect(store.accept({ "stable/x86_64": 1 })).rejects.toThrow(
      "state is locked",
    );
    await fs.rmdir(`${statePath}.lock`);
    await expect(store.accept({ "stable/x86_64": 1 })).resolves.toBeUndefined();
  });
});

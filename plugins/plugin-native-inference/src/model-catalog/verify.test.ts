/**
 * Model-file verification must separate "this file is not a GGUF" from "this
 * file could not be read". A read fault (EACCES/EIO/EMFILE/EBUSY while
 * llama.cpp holds the model open) is a real failure: reporting it as
 * `state: "truncated"` tells the user the download is corrupt and pushes a
 * multi-GB re-download for a file that is intact.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const BLOCKED_BASENAME = "blocked-permission.gguf";

const mocked = vi.hoisted(() => ({
  /** Absolute paths whose open() must fail with EACCES, as an unreadable file does. */
  blocked: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const patched = {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      if (mocked.blocked.has(path.resolve(target))) {
        throw Object.assign(
          new Error(`EACCES: permission denied, open '${target}'`),
          { code: "EACCES", errno: -13 },
        );
      }
      return actual.open(...args);
    },
  };
  return { ...patched, default: patched };
});

const { verifyInstalledModel } = await import("./verify.js");

const GGUF_WITH_PAYLOAD = Buffer.concat([
  Buffer.from("GGUF", "ascii"),
  Buffer.alloc(64, 7),
]);

function installedModel(modelPath: string) {
  return {
    id: "test-model",
    displayName: "Test model",
    path: modelPath,
    sizeBytes: GGUF_WITH_PAYLOAD.length,
    installedAt: new Date(0).toISOString(),
    source: "eliza-download" as const,
  };
}

describe("verifyInstalledModel against an unreadable file", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    mocked.blocked.clear();
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function stageModel(name = BLOCKED_BASENAME): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "eliza-verify-"));
    dirs.push(dir);
    const file = path.join(dir, name);
    await writeFile(file, GGUF_WITH_PAYLOAD);
    return file;
  }

  it("rejects instead of reporting a read fault as truncated", async () => {
    const file = await stageModel();
    mocked.blocked.add(path.resolve(file));

    await expect(
      verifyInstalledModel(installedModel(file)),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("still reports a real non-GGUF file as truncated", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eliza-verify-"));
    dirs.push(dir);
    const file = path.join(dir, "not-a-model.gguf");
    await writeFile(file, Buffer.from("NOPE-and-then-some-padding", "ascii"));

    await expect(
      verifyInstalledModel(installedModel(file)),
    ).resolves.toMatchObject({
      state: "truncated",
    });
  });

  it("still reports an absent file as missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eliza-verify-"));
    dirs.push(dir);

    await expect(
      verifyInstalledModel(installedModel(path.join(dir, "gone.gguf"))),
    ).resolves.toMatchObject({ state: "missing" });
  });
});

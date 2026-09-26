// @vitest-environment node
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { downloadAndVerifyArtifacts } from "./adb-backend";

const roots: string[] = [];
const payload = Buffer.from("complete verified artifact");
const artifact = {
  filename: "boot.img",
  sizeBytes: payload.length,
  sha256: createHash("sha256").update(payload).digest("hex"),
};
const urls = {
  "boot.img":
    "https://github.com/elizaOS/os/releases/download/fixture/boot.img",
};
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "eliza-download-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const fetched = async () => new Response(payload);

test("verified downloads are private and a concurrent attempt cannot replace them", async () => {
  const root = await directory();
  const outcomes = await Promise.allSettled(
    [1, 2].map(() =>
      downloadAndVerifyArtifacts(
        { artifacts: [artifact] },
        urls,
        root,
        () => {},
        fetched,
      ),
    ),
  );
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.status === "rejected"),
  ).toHaveLength(1);
  expect(await readFile(join(root, "boot.img"))).toEqual(payload);
  const stat = await lstat(join(root, "boot.img"));
  if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
  expect(stat.nlink).toBe(1);
  expect(await readdir(root)).toEqual(["boot.img"]);
});

test("pre-existing destination links and partial files remain untouched", async () => {
  const root = await directory();
  const target = join(root, "unrelated");
  await writeFile(target, "keep original");
  await writeFile(join(root, "boot.img.partial"), "keep prior partial");
  await symlink(target, join(root, "boot.img"));
  await expect(
    downloadAndVerifyArtifacts(
      { artifacts: [artifact] },
      urls,
      root,
      () => {},
      fetched,
    ),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(target, "utf8")).toBe("keep original");
  expect(await readFile(join(root, "boot.img.partial"), "utf8")).toBe(
    "keep prior partial",
  );
  expect((await lstat(join(root, "boot.img"))).isSymbolicLink()).toBe(true);
  expect((await readdir(root)).sort()).toEqual([
    "boot.img",
    "boot.img.partial",
    "unrelated",
  ]);
});

test("unsafe filenames and symlink staging directories fail before fetching", async () => {
  const root = await directory();
  const fetcher = vi.fn(fetched);
  await expect(
    downloadAndVerifyArtifacts(
      { artifacts: [{ ...artifact, filename: "../escape" }] },
      urls,
      root,
      () => {},
      fetcher,
    ),
  ).rejects.toThrow("file contract");
  const destination = join(root, "linked");
  await symlink(root, destination, "dir");
  await expect(
    downloadAndVerifyArtifacts(
      { artifacts: [artifact] },
      urls,
      destination,
      () => {},
      fetcher,
    ),
  ).rejects.toThrow("private directory");
  expect(fetcher).not.toHaveBeenCalled();
});

test("hash failures remove only this attempt's unpublished files", async () => {
  const root = await directory();
  await writeFile(join(root, "boot.img.partial"), "prior attempt");
  await expect(
    downloadAndVerifyArtifacts(
      { artifacts: [{ ...artifact, sha256: "a".repeat(64) }] },
      urls,
      root,
      () => {},
      fetched,
    ),
  ).rejects.toThrow("Integrity mismatch");
  expect(await readdir(root)).toEqual(["boot.img.partial"]);
  expect(await readFile(join(root, "boot.img.partial"), "utf8")).toBe(
    "prior attempt",
  );
});

test("oversize responses are cancelled rather than consumed or published", async () => {
  const root = await directory();
  const cancel = vi.fn();
  const fetcher = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(artifact.sizeBytes + 1));
        },
        cancel,
      }),
    );
  await expect(
    downloadAndVerifyArtifacts(
      { artifacts: [artifact] },
      urls,
      root,
      () => {},
      fetcher,
    ),
  ).rejects.toThrow("exceeds signed size");
  expect(cancel).toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

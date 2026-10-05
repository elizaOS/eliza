import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("asset replacement removes orphans only after the next tree is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "ui-assets-"));
  const script = join(root, "packages/ui/scripts/sync-to-public.ts");
  const source = join(root, "packages/ui/assets/background");
  const target = join(root, "public");
  const background = join(target, "brand/background");
  try {
    await mkdir(join(root, "packages/ui/scripts"), { recursive: true });
    await mkdir(join(root, "packages/scripts"), { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(background, { recursive: true });
    await cp(new URL("./sync-to-public.ts", import.meta.url), script);
    await cp(
      new URL("../../scripts/rm-path-recursive.ts", import.meta.url),
      join(root, "packages/scripts/rm-path-recursive.ts"),
    );
    await writeFile(join(source, "image.webp"), "next");
    await writeFile(join(source, "video.mp4"), "video");
    await writeFile(join(background, "orphan.webp"), "previous");
    await symlink(join(source, "missing"), join(source, "broken.webp"));
    const run = (...flags: string[]) =>
      spawnSync(process.execPath, [script, target, ...flags], {
        encoding: "utf8",
      });
    assert.notEqual(run("--background").status, 0);
    assert.equal(
      await readFile(join(background, "orphan.webp"), "utf8"),
      "previous",
    );
    assert.deepEqual(await readdir(join(target, "brand")), ["background"]);
    await rm(join(source, "broken.webp"));
    const synced = run("--background");
    assert.equal(synced.status, 0, synced.stderr);
    assert.deepEqual(await readdir(background), ["image.webp"]);
    assert.equal(run("--background", "--background-videos").status, 0);
    assert.deepEqual((await readdir(background)).sort(), [
      "image.webp",
      "video.mp4",
    ]);
    assert.notEqual(run("--background", "--unknown").status, 0);
    assert.deepEqual((await readdir(background)).sort(), [
      "image.webp",
      "video.mp4",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Exercises staged absolute directory-link publication with real filesystem
 * renames and fresh Node consumers. Windows uses junctions without requiring
 * Developer Mode; POSIX runs the relocation algorithm with absolute symlinks.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  collectStagedDirectoryLinks,
  relocateStagedDirectoryLinks,
} from "./plugin-staging-links.ts";

let temporary: string;
const linkType = process.platform === "win32" ? "junction" : "dir";
beforeEach(async () => {
  temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "staged-link-publication-"),
  );
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});
async function makeGeneration(): Promise<string> {
  const root = path.join(temporary, ".tmp-owned");
  const leaf = path.join(root, "leaf");
  await fs.mkdir(leaf, { recursive: true });
  await fs.writeFile(
    path.join(leaf, "index.mjs"),
    "import { readFileSync } from 'node:fs'; export const identity = {}; export const value = readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');",
  );
  await fs.writeFile(path.join(leaf, "asset.txt"), "owned");
  await fs.symlink(leaf, path.join(root, "left"), linkType);
  await fs.symlink(leaf, path.join(root, "right"), linkType);
  await fs.writeFile(
    path.join(root, "index.mjs"),
    "import { identity as left, value } from './left/index.mjs'; import { identity as right } from './right/index.mjs'; console.log(JSON.stringify({same: left === right, value}));",
  );
  return root;
}
function consume(root: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [path.join(root, "index.mjs")], {
      encoding: "utf8",
    }),
  );
}
it("publishes complete directory aliases that survive the atomic rename", async () => {
  const root = await makeGeneration();
  const plan = await collectStagedDirectoryLinks(root);
  const published = path.join(temporary, "content-owned");
  await relocateStagedDirectoryLinks(plan, root, published);
  await fs.rename(root, published);
  expect(consume(published)).toEqual({ same: true, value: "owned" });
  expect(await fs.realpath(path.join(published, "left"))).toBe(
    await fs.realpath(path.join(published, "leaf")),
  );
});
it("retargets fallback from recorded edges instead of adopting a competing cache tree", async () => {
  const root = await makeGeneration();
  const plan = await collectStagedDirectoryLinks(root);
  const cache = path.join(temporary, "content-raced");
  await relocateStagedDirectoryLinks(plan, root, cache);
  await fs.mkdir(path.join(cache, "leaf"), { recursive: true });
  await fs.writeFile(
    path.join(cache, "leaf", "index.mjs"),
    "export const identity = {}; export const value = 'competing-tree';",
  );
  const fallback = path.join(temporary, "generation-unpublished");
  await relocateStagedDirectoryLinks(plan, root, fallback);
  await fs.rename(root, fallback);
  expect(consume(fallback)).toEqual({ same: true, value: "owned" });
  expect(
    await fs.readFile(path.join(cache, "leaf", "index.mjs"), "utf8"),
  ).toContain("competing-tree");
});
it("keeps existing external dependency links outside the relocation plan", async () => {
  const root = await makeGeneration();
  const external = path.join(temporary, "external-package");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "asset.txt"), "external");
  await fs.symlink(external, path.join(root, "external"), linkType);
  const plan = await collectStagedDirectoryLinks(root);
  const published = path.join(temporary, "content-owned");
  await relocateStagedDirectoryLinks(plan, root, published);
  await fs.rename(root, published);
  expect(consume(published)).toEqual({ same: true, value: "owned" });
  expect(
    await fs.readFile(path.join(published, "external/asset.txt"), "utf8"),
  ).toBe("external");
  expect(await fs.realpath(path.join(published, "external"))).toBe(
    await fs.realpath(external),
  );
});
it("rejects a link-parent replacement before touching files outside the generation", async () => {
  const root = await makeGeneration();
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  await fs.symlink(
    path.join(root, "leaf"),
    path.join(nested, "alias"),
    linkType,
  );
  const plan = await collectStagedDirectoryLinks(root);
  const outside = path.join(temporary, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "alias"), "untouched");
  await fs.rename(nested, path.join(root, "original-nested"));
  await fs.symlink(outside, nested, linkType);
  await expect(
    relocateStagedDirectoryLinks(
      plan,
      root,
      path.join(temporary, "content-owned"),
    ),
  ).rejects.toMatchObject({ code: "STAGED_DIRECTORY_LINK_INVALID" });
  expect(await fs.readFile(path.join(outside, "alias"), "utf8")).toBe(
    "untouched",
  );
  expect(consume(root)).toEqual({ same: true, value: "owned" });
});

it.each([
  { link: "../outside", target: "leaf" },
  { link: "left", target: "../outside" },
])(
  "rejects malformed relocation edges before changing any alias: %j",
  async (invalid) => {
    const root = await makeGeneration();
    const plan = await collectStagedDirectoryLinks(root);
    const originalTarget = await fs.readlink(path.join(root, "left"));
    await expect(
      relocateStagedDirectoryLinks(
        [...plan, invalid],
        root,
        path.join(temporary, "content-owned"),
      ),
    ).rejects.toMatchObject({ code: "STAGED_DIRECTORY_LINK_INVALID" });
    expect(await fs.readlink(path.join(root, "left"))).toBe(originalTarget);
    expect(consume(root)).toEqual({ same: true, value: "owned" });
  },
);
it("cleans only the owned temporary tree from a partially retargeted state", async () => {
  const root = await makeGeneration();
  const plan = await collectStagedDirectoryLinks(root);
  const cache = path.join(temporary, "content-winner");
  await fs.mkdir(path.join(cache, "leaf"), { recursive: true });
  await fs.writeFile(path.join(cache, "leaf", "asset.txt"), "winner-preserved");
  // This is the filesystem state if a later edge fails after the first rewrite.
  const first = plan.find((edge) => edge.link === "left");
  if (!first) throw new Error("Fixture has no left alias");
  await relocateStagedDirectoryLinks([first], root, cache);
  await fs.rm(root, { recursive: true, force: true });
  expect(await fs.readFile(path.join(cache, "leaf", "asset.txt"), "utf8")).toBe(
    "winner-preserved",
  );
  await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

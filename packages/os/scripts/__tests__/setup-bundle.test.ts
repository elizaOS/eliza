/** Packaged setup must resolve its SDK without workspace dependencies or runtime downloads. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import config from "../../setup/electrobun.config";

test("setup bundles the Electrobun SDK into its launcher entrypoint", async () => {
  const result = await Bun.build({
    ...config.build.bun,
    entrypoints: [
      resolve(import.meta.dir, "../../setup", config.build.bun.entrypoint),
    ],
    target: "bun",
    write: false,
  });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  const code = await result.outputs[0].text();
  const imports = new Bun.Transpiler({
    loader: "js",
    target: "bun",
  }).scanImports(code);
  expect(
    imports.filter(
      ({ path }) => path === "electrobun" || path.startsWith("electrobun/"),
    ),
  ).toEqual([]);
});

test("packaged signed installer loads its executor and repository policy in isolation", async () => {
  const { mkdtemp, mkdir, cp, writeFile, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const stage = await mkdtemp(join(tmpdir(), "eliza-setup-bundle-"));
  try {
    for (const [source, destination] of Object.entries(config.build.copy)) {
      if (source === "dist") continue;
      const target = join(stage, destination);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(import.meta.dir, "../../setup", source), target);
    }
    const policy = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        'import {loadPolicy} from "./scripts/android/release-contract.mjs"; const p=loadPolicy(); if (!p.trust || !p.inventory.targets.length) process.exit(2);',
      ],
      { cwd: stage, encoding: "utf8", timeout: 10_000 },
    );
    expect(policy.error).toBeUndefined();
    expect(policy.stderr).toBe("");
    expect(policy.status).toBe(0);
    const manifest = join(stage, "invalid-contract.json");
    await writeFile(manifest, '{"schemaVersion":2}');
    const rejected = spawnSync(
      "bash",
      [
        join(stage, "android/installer/install-elizaos-android.sh"),
        "--manifest",
        manifest,
        "--artifact-dir",
        stage,
        "--execute",
        "--confirm-flash",
      ],
      { cwd: stage, encoding: "utf8", timeout: 10_000 },
    );
    expect(rejected.error).toBeUndefined();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("[android-contract]");
    expect(rejected.stderr).not.toContain("MODULE_NOT_FOUND");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

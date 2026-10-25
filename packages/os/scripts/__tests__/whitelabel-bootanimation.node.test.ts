import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Renders and packs a white-label boot animation from placeholder assets kept
// outside the repository, using the same Makefile entrypoints as `make
// bootanimation` with ELIZA_WHITELABEL_DIR set.
const osRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = path.resolve(osRoot, "../..");
const generator = path.join(
  osRoot,
  "scripts/android/generate-eliza-bootanimation.ts",
);
const packer = path.join(
  osRoot,
  "scripts/android/build-bootanimation.ts",
);
const sharp = createRequire(path.join(repoRoot, "packages/app/package.json"))(
  "sharp",
);

async function placeholderBrand(bootanimation: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "eliza-whitelabel-boot-"));
  const png = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  for (const name of ["icon.png", "splash.png", "boot.png"]) {
    await writeFile(path.join(dir, name), png);
  }
  await writeFile(
    path.join(dir, "brand.json"),
    JSON.stringify({
      schemaVersion: 1,
      appName: "Placeholder",
      icon: "icon.png",
      splash: "splash.png",
      ...(bootanimation === undefined ? {} : { bootanimation }),
    }),
  );
  return dir;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: osRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 300_000,
  });
}

test("white-label boot animation uses private logo and field color", async () => {
  const brand = await placeholderBrand({
    logo: "boot.png",
    background: "#102030",
  });
  const out = await mkdtemp(path.join(tmpdir(), "eliza-whitelabel-frames-"));
  try {
    const rendered = run(generator, ["--out-dir", out], {
      ELIZA_WHITELABEL_DIR: brand,
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(
      await readFile(path.join(out, "desc.txt"), "utf8"),
      "1080 2400 30\np 1 0 part0\np 0 0 part1\n",
    );
    assert.equal((await readdir(path.join(out, "part0"))).length, 16);
    const { data } = await sharp(path.join(out, "part1", "0000.png"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [0x10, 0x20, 0x30]);

    const zip = path.join(out, "bootanimation.zip");
    const packed = run(packer, ["--frames", out, "--out", zip], {});
    assert.equal(packed.status, 0, packed.stderr);
    const checked = run(packer, ["--frames", out, "--out", zip, "--check"], {});
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    await rm(brand, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("white-label brand without boot artwork cannot ship the upstream splash", async () => {
  const brand = await placeholderBrand(undefined);
  const out = await mkdtemp(path.join(tmpdir(), "eliza-whitelabel-frames-"));
  try {
    const rendered = run(generator, ["--out-dir", out], {
      ELIZA_WHITELABEL_DIR: brand,
    });
    assert.equal(rendered.status, 1);
    assert.match(rendered.stderr, /bootanimation\.logo/);
    assert.deepEqual(await readdir(out), []);
  } finally {
    await rm(brand, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

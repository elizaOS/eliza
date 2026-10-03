import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertReleaseBundlesEqual } from "../release-asset-inventory.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "release-bundles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, "expected");
  const observed = join(root, "observed");
  for (const dir of [expected, observed]) {
    await mkdir(dir);
    await writeFile(join(dir, "image.raw.zst"), "image bytes");
    await writeFile(join(dir, "manifest.json"), '{"version":1}');
    await writeFile(join(dir, "SHA256SUMS"), "checksum metadata");
  }
  return { root, expected, observed };
}

test("compares the complete bundle through the production CLI", async (t) => {
  const { expected, observed } = await fixture(t);
  assert.equal((await assertReleaseBundlesEqual(expected, observed)).length, 3);
  const script = new URL("../release-asset-inventory.ts", import.meta.url);
  const output = execFileSync(
    process.execPath,
    [
      script.pathname,
      "compare-bundles",
      "--expected",
      expected,
      "--observed",
      observed,
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /Verified 3 exact release bundle files/);
});

for (const mutation of [
  "same-size payload",
  "manifest",
  "checksums",
  "missing",
  "extra",
  "symlink",
  "directory",
  "empty",
]) {
  test(`rejects ${mutation} changes`, async (t) => {
    const { expected, observed } = await fixture(t);
    const payload = join(observed, "image.raw.zst");
    if (mutation === "same-size payload")
      await writeFile(payload, "other bytes");
    if (mutation === "manifest")
      await writeFile(join(observed, "manifest.json"), '{"version":2}');
    if (mutation === "checksums")
      await writeFile(join(observed, "SHA256SUMS"), "replaced metadata");
    if (["missing", "symlink", "directory"].includes(mutation))
      await rm(payload);
    if (mutation === "extra") await writeFile(join(observed, "extra"), "extra");
    if (mutation === "symlink")
      await symlink(join(expected, "image.raw.zst"), payload);
    if (mutation === "directory") await mkdir(payload);
    if (mutation === "empty") await writeFile(payload, "");
    await assert.rejects(
      assertReleaseBundlesEqual(expected, observed),
      /differs|regular file/,
    );
  });
}

test("rejects empty bundles and linked bundle roots", async (t) => {
  const { root, expected, observed } = await fixture(t);
  await rm(observed, { recursive: true });
  await mkdir(observed);
  await assert.rejects(assertReleaseBundlesEqual(observed, observed), /empty/);
  const linked = join(root, "linked");
  await symlink(expected, linked);
  await assert.rejects(
    assertReleaseBundlesEqual(expected, linked),
    /non-symlink directory/,
  );
});

test("promotion shell refuses a same-count substitution before publishing", async (t) => {
  const { root, expected, observed } = await fixture(t);
  const { chmod, cp, readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL(
        "../../.github/workflows/elizaos-os-full-release.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const shell = workflow.jobs["publish-release"].steps.find(
    (step) => step.name === "Require the exact staged draft",
  ).run;
  await cp(expected, join(root, "_expected-release"), { recursive: true });
  await mkdir(join(root, "packages/os"), { recursive: true });
  await mkdir(join(root, "packages/os/scripts"));
  for (const filename of ["release-asset-inventory.ts", "os-release-lib.ts"]) {
    await cp(
      new URL(`../${filename}`, import.meta.url),
      join(root, "packages/os/scripts", filename),
    );
  }
  const bin = join(root, "bin");
  await mkdir(bin);
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'download') {
  fs.cpSync(process.env.OBSERVED, '_staged-release', {recursive:true});
} else if (args[0] === 'api' && args.some(x => x.includes('/assets?'))) {
  console.log(JSON.stringify([[{id:1,name:'image.raw.zst'},{id:2,name:'manifest.json'},{id:3,name:'SHA256SUMS'}]]));
} else if (args[0] === 'api' && args.some(x => x.includes('/commits/'))) {
  console.log(process.env.SOURCE_SHA);
} else if (args[0] === 'api' && args.some(x => x.includes('/releases/tags/'))) {
  console.log(JSON.stringify({id:7,tag_name:process.env.RELEASE_TAG,draft:true,immutable:false}));
} else { throw new Error('Unexpected gh command: '+JSON.stringify(args)); }
`,
  );
  await chmod(gh, 0o755);
  const options = {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "elizaOS/eliza",
      RELEASE_TAG: "v1.0.0",
      SOURCE_SHA: "a".repeat(40),
      EXPECTED_ASSET_COUNT: "3",
      OBSERVED: observed,
    },
    stdio: "pipe",
  };
  execFileSync("bash", ["-c", shell], options);
  await rm(join(root, "_staged-release"), { recursive: true });
  await writeFile(join(observed, "image.raw.zst"), "other bytes");
  assert.throws(
    () => execFileSync("bash", ["-c", shell], options),
    (error) =>
      error.status !== 0 &&
      error.stderr.includes("differs from the verified publication input"),
  );
});

test("a symlinked CLI executes verification instead of silently succeeding", async (t) => {
  const { root, expected, observed } = await fixture(t);
  const entrypoint = join(root, "verify-release.mjs");
  await symlink(
    new URL("../release-asset-inventory.ts", import.meta.url).pathname,
    entrypoint,
  );
  const args = [
    entrypoint,
    "compare-bundles",
    "--expected",
    expected,
    "--observed",
    observed,
  ];
  assert.match(
    execFileSync(process.execPath, args, { encoding: "utf8" }),
    /Verified 3 exact release bundle files/,
  );
  await writeFile(join(observed, "image.raw.zst"), "other bytes");
  assert.throws(
    () => execFileSync(process.execPath, args, { stdio: "pipe" }),
    (error) =>
      error.status !== 0 &&
      error.stderr.includes("differs from the verified publication input"),
  );
});

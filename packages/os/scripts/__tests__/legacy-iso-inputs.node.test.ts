import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
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
import { fileURLToPath } from "node:url";

const builder = fileURLToPath(
  new URL("../../linux/elizaos/build-live-iso.sh", import.meta.url),
);

test("invalid legacy ISO inputs fail before creating output or touching prior build state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-iso-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "chroot"));
  const marker = join(directory, "chroot", "keep");
  await writeFile(marker, "prior build state");
  for (const [name, value] of [
    ["ELIZAOS_ARCH", "mips"],
    ["ELIZAOS_PROFILE", "secure"],
    ["ELIZAOS_MIN_ISO_BYTES", "0"],
    ["ELIZAOS_MIN_ISO_BYTES", "-1"],
    ["ELIZAOS_MIN_ISO_BYTES", "10MiB"],
    ["ELIZAOS_MIN_ISO_BYTES", "9999999999999999999"],
  ]) {
    const result = spawnSync("/bin/bash", [builder], {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        ELIZAOS_VARIANT_DIR: directory,
        ELIZAOS_OUT_DIR: join(directory, "out"),
        [name]: value,
      },
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 64, result.stderr);
    assert.ok(result.stderr.includes(name), result.stderr);
    assert.equal(await readFile(marker, "utf8"), "prior build state");
    assert.deepEqual(await readdir(directory), ["chroot"]);
  }
});

test("a late branding renderer failure preserves existing build inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-branding-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["assets", "config", "bin"])
    await mkdir(join(directory, name));
  for (const name of [
    "logo_white_nobg",
    "logo_blue_nobg",
    "elizaOS_text_white",
  ])
    await writeFile(join(directory, "assets", `${name}.svg`), "fixture");
  const marker = join(directory, "config", "keep");
  await writeFile(marker, "existing input");
  // Earlier renders succeed. The final icon fails before publication begins.
  for (const [name, script] of [
    [
      "rsvg-convert",
      '[[ "$2" == 512 ]] && exit 17\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then printf fixture > "$2"; exit 0; fi; shift; done\nexit 18',
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion in the fake renderer.
    ["convert", 'output="${@: -1}"\nprintf fixture > "${output#PNG24:}"'],
  ]) {
    const path = join(directory, "bin", name);
    await writeFile(path, `#!/bin/bash\n${script}\n`);
    await chmod(path, 0o755);
  }
  const script = fileURLToPath(
    new URL("../linux/generate-elizaos-brand-assets.sh", import.meta.url),
  );
  const result = spawnSync("/bin/bash", [script, directory], {
    encoding: "utf8",
    env: { PATH: `${directory}/bin:/usr/bin:/bin` },
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(await readdir(join(directory, "config")), ["keep"]);
  assert.equal(await readFile(marker, "utf8"), "existing input");
});

test("legacy builder enters the selected variant while resolving output from the caller", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-iso-cwd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["variant", "bin"]) await mkdir(join(directory, name));
  await writeFile(join(directory, "variant/debian-snapshot.lock.json"), "{}");
  await writeFile(
    join(directory, "variant/manifest.amd64.default.json.template"),
    "{}",
  );
  // Stop at snapshot validation, before network access or cleanup, and record
  // the actual cwd inherited by the build's subprocesses.
  for (const [name, body] of [
    ["lb", "exit 99"],
    ["xorriso", "exit 99"],
    ["python3", 'pwd > "$CWD_RECEIPT"\nexit 17'],
  ]) {
    const path = join(directory, "bin", name);
    await writeFile(path, `#!/bin/bash\n${body}\n`);
    await chmod(path, 0o755);
  }
  const receipt = join(directory, "cwd");
  const result = spawnSync("/bin/bash", [builder], {
    cwd: directory,
    encoding: "utf8",
    env: {
      PATH: `${directory}/bin:/usr/bin:/bin`,
      CWD_RECEIPT: receipt,
      ELIZAOS_VARIANT_DIR: "variant",
      ELIZAOS_OUT_DIR: "output",
    },
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(
    (await readFile(receipt, "utf8")).trim(),
    join(directory, "variant"),
  );
  assert.deepEqual(await readdir(join(directory, "output")), []);
  assert.deepEqual(await readdir(join(directory, "variant")), [
    "debian-snapshot.lock.json",
    "manifest.amd64.default.json.template",
  ]);
});

test("missing release manifest is rejected before output creation or build cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-iso-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "chroot"));
  await writeFile(join(directory, "chroot/keep"), "prior build");
  const result = spawnSync("/bin/bash", [builder], {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ELIZAOS_VARIANT_DIR: directory },
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 69, result.stderr);
  assert.match(result.stderr, /no release manifest contract/);
  assert.deepEqual(await readdir(directory), ["chroot"]);
  assert.equal(
    await readFile(join(directory, "chroot/keep"), "utf8"),
    "prior build",
  );
});

test("manifest stage handles quoted paths and refuses unresolved fields or overwrites", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-manifest-'quote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(builder, "utf8");
  const start = source.indexOf('SHA256="$(awk');
  assert.ok(start > 0);
  const stage = source.slice(start);
  const template = join(directory, "template.json");
  const destination = join(directory, "fixture.manifest.json");
  await writeFile(
    join(directory, "fixture.iso.sha256"),
    `${"a".repeat(64)}  fixture.iso\n`,
  );
  const run = () =>
    spawnSync("/bin/bash", ["-euc", stage], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        OUT: directory,
        TEMPLATE: template,
        ARTIFACT_BASENAME: "fixture",
        ARCH: "amd64",
        PROFILE: "gui",
        BUILD_TS: "20260925T000000Z",
        ISO_BYTES: "100",
        APP_SOURCE_COMMIT: "b".repeat(40),
        APP_ARTIFACT_SHA256: "c".repeat(64),
        DEBIAN_SNAPSHOT_SERIAL: "20260925T000000Z",
        DEBIAN_BASE_IMAGE: "fixture",
      },
      timeout: 5000,
    });
  await writeFile(template, '{"missing":"@@UNKNOWN@@"}');
  assert.notEqual(run().status, 0);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
  await writeFile(
    template,
    '{"filename":"@@FILENAME@@","sha256":"@@SHA256@@","sizeBytes":@@SIZE_BYTES@@}',
  );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const content = await readFile(destination, "utf8");
  assert.deepEqual(JSON.parse(content), {
    filename: "fixture.iso",
    sha256: "a".repeat(64),
    sizeBytes: 100,
  });
  assert.notEqual(run().status, 0);
  assert.equal(await readFile(destination, "utf8"), content);
});

test("ISO selection rejects wrong-architecture, ambiguous and symlinked artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-iso-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(builder, "utf8");
  const start = source.indexOf('SRC_ISO=""');
  const end = source.indexOf('ISO_BYTES="$(stat', start);
  assert.ok(start > 0 && end > start);
  const stage = `${source.slice(start, end)}\nprintf '%s' "$SRC_ISO"`;
  const run = () =>
    spawnSync("/bin/bash", ["-euc", stage], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HERE: directory, ARCH: "amd64" },
      timeout: 5000,
    });
  const primary = join(directory, "live-image-amd64.hybrid.iso");
  const legacy = join(directory, "binary.hybrid.iso");
  const other = join(directory, "live-image-arm64.hybrid.iso");
  await writeFile(other, "other architecture");
  assert.equal(run().status, 2);
  await symlink(other, primary);
  assert.equal(run().status, 2);
  await rm(primary);
  await writeFile(primary, "expected artifact");
  assert.equal(run().status, 0);
  assert.equal(run().stdout, primary);
  await writeFile(legacy, "second artifact");
  assert.equal(run().status, 2);
  await rm(primary);
  assert.equal(run().status, 0);
  assert.equal(run().stdout, legacy);
});

test("existing release outputs stop publication before moving the ISO", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-iso-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(builder, "utf8");
  const start = source.indexOf('DST_ISO="');
  const end = source.indexOf('echo "    artifact:', start);
  assert.ok(start > 0 && end > start);
  const stage = source.slice(start, end);
  const iso = join(directory, "source.iso");
  await writeFile(iso, "new image");
  for (const suffix of ["iso", "iso.sha256", "manifest.json"]) {
    const destination = join(directory, `fixture.${suffix}`);
    await writeFile(destination, "previous release");
    const result = spawnSync("/bin/bash", ["-euc", stage], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        OUT: directory,
        SRC_ISO: iso,
        ARTIFACT_BASENAME: "fixture",
      },
      timeout: 5000,
    });
    assert.equal(result.status, 73, result.stderr);
    assert.equal(await readFile(destination, "utf8"), "previous release");
    assert.equal(await readFile(iso, "utf8"), "new image");
    await rm(destination);
  }
});

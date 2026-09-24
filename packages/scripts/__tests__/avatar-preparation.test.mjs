/** Exercises avatar preparation as real CLI processes in flat and nested consumer layouts.
 * Generated gzip files are read back byte-for-byte; missing prerequisites must fail.
 * Download-copy cases substitute only Git transport with a pinned-shape asset fixture.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const scripts = fileURLToPath(
  new URL("../../app/scripts/", import.meta.url),
);
function fixture(t, nested = false, appName = "app") {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "avatar-preparation-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = nested ? path.join(root, "eliza") : root;
  const app = path.join(root, nested ? "apps" : "packages", appName);
  for (const dir of [
    root,
    workspace,
    app,
    path.join(root, nested ? "apps" : "packages", "app"),
    path.join(workspace, "packages/app"),
    path.join(workspace, "packages/agent"),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
  }
  const target = path.join(workspace, "packages/app/scripts");
  mkdirSync(path.join(target, "lib"), { recursive: true });
  for (const file of [
    "ensure-avatars.mjs",
    "process-vrms.mjs",
    "lib/app-dir.mjs",
    "lib/repo-root.mjs",
  ])
    cpSync(path.join(scripts, file), path.join(target, file));
  const put = (name, bytes) => {
    const dest = path.join(app, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  };
  const run = (env = {}) =>
    spawnSync(
      process.execPath,
      [path.join(target, "ensure-avatars.mjs"), `--app=${appName}`],
      {
        cwd: root,
        env: { ...process.env, SKIP_AVATAR_CLONE: "", ...env },
        encoding: "utf8",
        timeout: 15000,
      },
    );
  return { root, target, app, put, run };
}

for (const nested of [false, true]) {
  test(`reuses compressed assets in the ${nested ? "consumer" : "flat"} renderer`, (t) => {
    const { put, run } = fixture(t, nested);
    put("public/vrms/eliza-1.vrm.gz", gzipSync(randomBytes(2048)));
    put("public/animations/emotes/wave.glb.gz", gzipSync(randomBytes(2048)));
    const result = run({ PATH: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already present/);
  });
  test(`processes local characters into the ${nested ? "consumer" : "flat"} renderer`, (t) => {
    const { app, put, run } = fixture(t, nested);
    const bytes = randomBytes(4096);
    put("characters/vrm/Chen.vrm", bytes);
    put("public/animations/emotes/wave.glb.gz", gzipSync(randomBytes(2048)));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      gunzipSync(readFileSync(path.join(app, "public/vrms/eliza-1.vrm.gz"))),
      bytes,
    );
    assert.deepEqual(
      readFileSync(path.join(app, "public_src/vrms/eliza-1.vrm")),
      bytes,
    );
  });
}

test("missing preparation prerequisites return a failing process status", (t) => {
  const { run } = fixture(t);
  const result = run({ PATH: "" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /git not found/);
});

test("explicit network opt-out stays distinguishable from installed assets", (t) => {
  const { run } = fixture(t);
  const result = run({ PATH: "", SKIP_AVATAR_CLONE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIP_AVATAR_CLONE set/);
  assert.doesNotMatch(result.stdout, /assets installed|already present/);
});

for (const nested of [false, true]) {
  test(`maps source asset names into the ${nested ? "consumer" : "flat"} app catalog`, async (t) => {
    const { root, target, app } = fixture(t, nested);
    const sourceBytes = randomBytes(4096);
    const imageBytes = randomBytes(2048);
    const { runEnsureAvatars } = await import(
      pathToFileURL(path.join(target, "ensure-avatars.mjs")).href
    );
    const result = runEnsureAvatars({
      log() {},
      _gitAvailable: () => true,
      _exec(command) {
        if (!command.startsWith("git clone")) return;
        const downloaded = path.join(root, ".avatar-clone-tmp");
        const put = (name, bytes) => {
          const file = path.join(downloaded, name);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, bytes);
        };
        for (let id = 1; id <= 8; id++) {
          put(`vrms/milady-${id}.vrm`, sourceBytes);
          put(`vrms/previews/milady-${id}.png`, imageBytes);
          put(`vrms/backgrounds/milady-${id}.png`, imageBytes);
        }
        put("animations/emotes/wave.glb", sourceBytes);
      },
    });
    assert.equal(result.vrmsOk, true);
    assert.equal(result.animsOk, true);
    for (let id = 1; id <= 8; id++) {
      assert.deepEqual(
        gunzipSync(
          readFileSync(path.join(app, `public/vrms/eliza-${id}.vrm.gz`)),
        ),
        sourceBytes,
      );
      assert.deepEqual(
        readFileSync(path.join(app, `public/vrms/previews/eliza-${id}.png`)),
        imageBytes,
      );
      assert.deepEqual(
        readFileSync(path.join(app, `public/vrms/backgrounds/eliza-${id}.png`)),
        imageBytes,
      );
    }
    assert.deepEqual(
      gunzipSync(
        readFileSync(path.join(app, "public/animations/emotes/wave.glb.gz")),
      ),
      sourceBytes,
    );
  });
}

test("prepares the explicitly selected desktop app instead of the default renderer", (t) => {
  const { app, put, run } = fixture(t, true, "custom-desktop");
  const bytes = randomBytes(4096);
  put("characters/vrm/Chen.vrm", bytes);
  put("public/animations/emotes/wave.glb.gz", gzipSync(randomBytes(2048)));
  const prepared = run();
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(
    gunzipSync(readFileSync(path.join(app, "public/vrms/eliza-1.vrm.gz"))),
    bytes,
  );
  const reused = run({ PATH: "" });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /already present/);
});

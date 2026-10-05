import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAndroidConsumer } from "./build-consumer.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "android-build-consumer-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const environment = { TEST_ENV: "selected" };
  const options = {
    root,
    environment,
    variants: ["standalone", "launcher"],
    prepare: [
      { command: "admit", args: ["source"] },
      { command: "sync", args: [] },
    ],
    verify: { command: "verify", args: [] },
    archive: {
      name: "production",
      metadata: { mode: "production", nativeRuntime: false },
    },
    run: (command, args, opts) => {
      calls.push({ command, args, opts });
      if (command === "./gradlew")
        for (const variant of options.variants)
          for (const mode of ["debug", "release"]) {
            const file = path.join(
              root,
              "android/app/build/outputs/apk",
              variant,
              mode,
              `app-${variant}-${mode}${mode === "release" ? "-unsigned" : ""}.apk`,
            );
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${variant}:${mode}:current`);
          }
      if (command === "verify")
        fs.writeFileSync(
          path.join(root, "artifacts/apk-manifest.json"),
          JSON.stringify({ verified: true }),
        );
    },
  };
  return { root, calls, options, build: () => buildAndroidConsumer(options) };
}
test("selected variants are built and verified before archiving; unrelated APKs are not propagated", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "artifacts"));
  fs.writeFileSync(
    path.join(f.root, "artifacts/stale-other.apk"),
    "unselected",
  );
  const result = f.build();
  assert.deepEqual(
    f.calls.map((c) => c.command),
    ["admit", "sync", "./gradlew", "verify"],
  );
  const gradle = f.calls[2];
  assert.deepEqual(gradle.args, [
    "--no-daemon",
    ":app:assembleStandaloneDebug",
    ":app:assembleLauncherDebug",
    ":app:assembleStandaloneRelease",
    ":app:assembleLauncherRelease",
    ":app:assembleStandaloneDebugAndroidTest",
    ":app:assembleLauncherDebugAndroidTest",
    ":app:lint",
  ]);
  assert.equal(gradle.opts.cwd, path.join(f.root, "android"));
  assert.equal(gradle.opts.env, f.options.environment);
  assert.equal(result.files.length, 4);
  assert.equal(
    fs.existsSync(path.join(result.archive, "stale-other.apk")),
    false,
  );
  for (const file of result.files)
    assert.equal(
      fs.readFileSync(path.join(result.archive, path.basename(file)), "utf8"),
      fs.readFileSync(file, "utf8"),
    );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(result.archive, "service-mode.json"))),
    f.options.archive.metadata,
  );
});
test("admission and build failures cannot publish an archive", (t) => {
  for (const failed of ["admit", "sync", "./gradlew", "verify"]) {
    const f = fixture(t),
      run = f.options.run;
    f.options.run = (command, ...args) => {
      if (command === failed) throw Error("controlled failure");
      return run(command, ...args);
    };
    assert.throws(f.build, /controlled failure/);
    assert.equal(
      fs.existsSync(path.join(f.root, "artifacts/production")),
      false,
    );
    assert.equal(
      f.calls.some((c) => c.command === "verify"),
      false,
    );
  }
});
test("missing distribution output leaves previously collected artifacts untouched", (t) => {
  const f = fixture(t),
    run = f.options.run;
  fs.mkdirSync(path.join(f.root, "artifacts"));
  fs.writeFileSync(
    path.join(f.root, "artifacts/standalone-debug.apk"),
    "prior",
  );
  f.options.run = (command, ...args) => {
    run(command, ...args);
    if (command === "./gradlew")
      fs.unlinkSync(
        path.join(
          f.root,
          "android/app/build/outputs/apk/launcher/release/app-launcher-release-unsigned.apk",
        ),
      );
  };
  assert.throws(f.build, /ENOENT/);
  assert.equal(
    fs.readFileSync(
      path.join(f.root, "artifacts/standalone-debug.apk"),
      "utf8",
    ),
    "prior",
  );
  assert.equal(
    f.calls.some((c) => c.command === "verify"),
    false,
  );
});
test("invalid names, duplicates and unserializable metadata fail before any command", (t) => {
  for (const patch of [
    { variants: [] },
    { variants: ["../outside"] },
    { variants: ["launcher", "launcher"] },
    { archive: { name: "../escape", metadata: {} } },
    { verify: null },
    { archive: { name: "production", metadata: 1n } },
  ]) {
    const f = fixture(t);
    Object.assign(f.options, patch);
    assert.throws(f.build);
    assert.equal(f.calls.length, 0);
  }
});
test("daemon and fixture/native archive selection stay host-controlled", (t) => {
  const f = fixture(t);
  f.options.daemon = true;
  f.options.variants = ["launcher"];
  f.options.archive = {
    name: "native-fixture",
    metadata: { mode: "fixture", nativeRuntime: true, fixtureScenario: "test" },
  };
  const result = f.build();
  assert.equal(f.calls[2].args[0], "--daemon");
  assert.equal(result.files.length, 2);
  assert.equal(path.basename(result.archive), "native-fixture");
});

test("a successful verifier that produces no fresh manifest cannot reuse old evidence", (t) => {
  const f = fixture(t),
    run = f.options.run;
  fs.mkdirSync(path.join(f.root, "artifacts"));
  fs.writeFileSync(
    path.join(f.root, "artifacts/apk-manifest.json"),
    "old evidence",
  );
  f.options.run = (command, ...args) => {
    if (command !== "verify") run(command, ...args);
  };
  assert.throws(f.build, /ENOENT/);
  assert.equal(fs.existsSync(path.join(f.root, "artifacts/production")), false);
});

test("reusing an archive replaces its contents when selected variants shrink", (t) => {
  const f = fixture(t);
  const first = f.build();
  assert.equal(
    fs.existsSync(path.join(first.archive, "standalone-debug.apk")),
    true,
  );
  f.options.variants = ["launcher"];
  const second = f.build();
  assert.deepEqual(fs.readdirSync(second.archive).sort(), [
    "apk-manifest.json",
    "launcher-debug.apk",
    "launcher-release-unsigned.apk",
    "service-mode.json",
  ]);
});
test("archive assembly failure preserves the previous verified archive", (t) => {
  const f = fixture(t);
  const first = f.build();
  const before = Object.fromEntries(
    fs
      .readdirSync(first.archive)
      .map((name) => [
        name,
        fs.readFileSync(path.join(first.archive, name), "utf8"),
      ]),
  );
  const run = f.options.run;
  f.options.run = (command, ...args) => {
    run(command, ...args);
    if (command === "verify")
      fs.unlinkSync(path.join(f.root, "artifacts/launcher-debug.apk"));
  };
  assert.throws(f.build, /ENOENT/);
  assert.deepEqual(
    Object.fromEntries(
      fs
        .readdirSync(first.archive)
        .map((name) => [
          name,
          fs.readFileSync(path.join(first.archive, name), "utf8"),
        ]),
    ),
    before,
  );
  assert.equal(
    fs
      .readdirSync(path.join(f.root, "artifacts"))
      .some((name) => name.startsWith(".android-archive-")),
    false,
  );
});

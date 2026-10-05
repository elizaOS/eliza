import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AndroidConsumerHostError,
  generateAndroidConsumerHost,
} from "./consumer-host.mjs";
import { createConsumerFixture } from "./consumer-host-fixture.mjs";

const upstreamRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
);
function setup(t) {
  const consumerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "android-consumer-host-"),
  );
  t.after(() => fs.rmSync(consumerRoot, { recursive: true, force: true }));
  const options = {
    consumerRoot,
    upstreamRoot,
    output: path.join(consumerRoot, "android"),
    ...createConsumerFixture(consumerRoot, "example.consumer"),
  };
  return { options, generate: () => generateAndroidConsumerHost(options) };
}
test("regeneration preserves unrelated outputs and removes only formerly selected owned sources", (t) => {
  const { options, generate } = setup(t);
  options.profile.sourceFiles = [
    {
      source: { root: "consumer", path: "src/MainActivity.java" },
      sourceSet: "main",
      language: "java",
    },
  ];
  generate();
  const selected = path.join(
    options.output,
    "app/src/main/java/MainActivity.java",
  );
  assert.ok(fs.existsSync(selected));
  fs.writeFileSync(
    path.join(options.output, "local.properties"),
    "sdk.dir=/host/sdk\n",
  );
  delete options.profile.sourceFiles;
  generate();
  assert.equal(fs.existsSync(selected), false);
  assert.equal(
    fs.readFileSync(path.join(options.output, "local.properties"), "utf8"),
    "sdk.dir=/host/sdk\n",
  );
  // An interrupted prior cleanup can be retried even if a stale file is gone.
  const marker = path.join(options.output, ".eliza-consumer-host.json");
  const receipt = JSON.parse(fs.readFileSync(marker));
  receipt.files.push("missing.java");
  fs.writeFileSync(marker, JSON.stringify(receipt));
  generate();
});
test("an unowned project and changed identity are never overwritten", (t) => {
  const { options, generate } = setup(t);
  fs.mkdirSync(options.output);
  fs.writeFileSync(path.join(options.output, "build.gradle"), "user project");
  assert.throws(generate, /unowned Android project/);
  assert.equal(
    fs.readFileSync(path.join(options.output, "build.gradle"), "utf8"),
    "user project",
  );
  fs.unlinkSync(path.join(options.output, "build.gradle"));
  generate();
  options.identity.appId = "example.other";
  assert.throws(generate, /ownership differs/);
});
test("source traversal and symlink escapes fail before output creation", (t) => {
  const { options, generate } = setup(t);
  options.profile.manifest = { root: "consumer", path: "../foreign.xml" };
  assert.throws(generate, AndroidConsumerHostError);
  assert.equal(fs.existsSync(options.output), false);
  fs.symlinkSync(
    path.join(upstreamRoot, "package.json"),
    path.join(options.consumerRoot, "escape.xml"),
  );
  options.profile.manifest = { root: "consumer", path: "escape.xml" };
  assert.throws(generate, /escapes/);
  assert.equal(fs.existsSync(options.output), false);
});
test("generated destination and file symlinks cannot redirect writes", (t) => {
  const { options, generate } = setup(t);
  const foreign = path.join(options.consumerRoot, "foreign");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "untouched"), "original");
  fs.symlinkSync(foreign, options.output);
  assert.throws(generate, /symlinks/);
  fs.unlinkSync(options.output);
  generate();
  fs.unlinkSync(path.join(options.output, "build.gradle"));
  fs.symlinkSync(
    path.join(foreign, "untouched"),
    path.join(options.output, "build.gradle"),
  );
  assert.throws(generate, /symlinks/);
  assert.equal(
    fs.readFileSync(path.join(foreign, "untouched"), "utf8"),
    "original",
  );
});
test("new generated paths cannot overwrite unowned files inside an owned host", (t) => {
  const { options, generate } = setup(t);
  generate();
  const target = path.join(
    options.output,
    "app/src/main/java/MainActivity.java",
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "user source");
  options.profile.sourceFiles = [
    {
      source: { root: "consumer", path: "src/MainActivity.java" },
      sourceSet: "main",
      language: "java",
    },
  ];
  assert.throws(generate, /unowned generated-file/);
  assert.equal(fs.readFileSync(target, "utf8"), "user source");
});
test("invalid module, variant, SDK, coordinate and Java field declarations fail closed", (t) => {
  for (const mutate of [
    (p) => (p.modules = [{ name: "app" }]),
    (p) => (p.flavors = [{ name: "../other" }]),
    (p) => (p.sdk.min = 37),
    (p) =>
      (p.dependencies = [
        { configuration: "implementation", coordinate: "org.test:library:+" },
      ]),
    (p) =>
      (p.buildConfigFields = [{ name: "BAD", type: "boolean", value: "true" }]),
    (p) =>
      (p.buildConfigFields = [
        { name: "COUNT", type: "int", value: 2147483648 },
      ]),
  ]) {
    const { options, generate } = setup(t);
    mutate(options.profile);
    assert.throws(generate, AndroidConsumerHostError);
    assert.equal(fs.existsSync(options.output), false);
  }
});
test("toolchain is hash pinned and optional runtime preserves exact native bytes", (t) => {
  const { options, generate } = setup(t);
  const main = path.join(options.consumerRoot, "runtime/android/app/src/main");
  fs.mkdirSync(path.join(main, "assets/agent"), { recursive: true });
  fs.writeFileSync(path.join(main, "assets/agent/agent-bundle.js"), "fixture");
  fs.writeFileSync(
    path.join(main, "assets/agent-runtime.inventory"),
    "fixture",
  );
  options.runtimeDirectory = path.join(options.consumerRoot, "runtime");
  generate();
  const wrapper = fs.readFileSync(
    path.join(options.output, "gradle/wrapper/gradle-wrapper.properties"),
    "utf8",
  );
  assert.match(wrapper, /gradle-8\.13-bin/);
  assert.match(wrapper, /distributionSha256Sum=[a-f0-9]{64}/);
  const gradle = fs.readFileSync(
    path.join(options.output, "app/build.gradle"),
    "utf8",
  );
  assert.match(gradle, /keepDebugSymbols/);
  const normalized = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  assert.equal(normalized.identity.appId, "example.consumer");
  assert.equal(
    normalized.buildConfigFields[0].value,
    JSON.stringify('host "literal" $value'),
  );
});

test("a symlinked checkout root uses canonical ownership without admitting descendant symlinks", (t) => {
  const { options, generate } = setup(t);
  const actual = fs.realpathSync(options.consumerRoot),
    alias = `${actual}-alias`;
  fs.symlinkSync(actual, alias, "junction");
  t.after(() => fs.unlinkSync(alias));
  options.consumerRoot = alias;
  options.output = path.join(alias, "android");
  assert.equal(generate().directory, path.join(actual, "android"));
  options.output = path.join(actual, "android");
  generate();
  options.output = path.join(alias, "../escape");
  assert.throws(generate, /inside the consumer/);
});

test("changing dependency selectors are refused before generating any files", (t) => {
  for (const version of [
    "latest.release",
    "latest.integration",
    "1.0-SNAPSHOT",
  ]) {
    const { options, generate } = setup(t);
    options.profile.dependencies = [
      {
        configuration: "implementation",
        coordinate: `example:library:${version}`,
      },
    ];
    assert.throws(generate, /fixed coordinate/);
    assert.equal(fs.existsSync(options.output), false);
  }
});

test("a regular file cannot become a generated output directory", (t) => {
  const { options, generate } = setup(t);
  fs.writeFileSync(options.output, "user file");
  assert.throws(
    generate,
    (error) =>
      error instanceof AndroidConsumerHostError &&
      /directory/.test(error.message),
  );
  assert.equal(fs.readFileSync(options.output, "utf8"), "user file");
});

test("missing declared input reports a typed failure without creating output", (t) => {
  const { options, generate } = setup(t);
  options.profile.manifest = { root: "consumer", path: "missing.xml" };
  assert.throws(
    generate,
    (error) =>
      error instanceof AndroidConsumerHostError &&
      error.cause?.code === "ENOENT",
  );
  assert.equal(fs.existsSync(options.output), false);
});

test("independent modules remain included without becoming app dependencies", (t) => {
  const { options, generate } = setup(t);
  options.profile.modules = [
    { name: "library", source: { root: "consumer", path: "src" } },
    {
      name: "updater",
      source: { root: "consumer", path: "src" },
      appDependency: false,
    },
  ];
  generate();
  const profile = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  assert.deepEqual(
    profile.modules.map(({ name, appDependency }) => ({ name, appDependency })),
    [
      { name: "library", appDependency: true },
      { name: "updater", appDependency: false },
    ],
  );
  for (const value of [null, "false", 0, {}]) {
    options.profile.modules[1].appDependency = value;
    assert.throws(generate, /appDependency must be a boolean/);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(options.output, ".eliza-consumer-profile.json"),
        ),
      ),
      profile,
    );
  }
});

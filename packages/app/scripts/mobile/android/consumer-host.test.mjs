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
test("a moved checkout keeps owning its generated host; another output place does not", (t) => {
  const { options, generate } = setup(t);
  options.profile.manifest = {
    root: "consumer",
    path: "android/app/src/main/AndroidManifest.xml",
  };
  fs.mkdirSync(path.join(options.output, "app/src/main"), { recursive: true });
  fs.copyFileSync(
    path.join(options.consumerRoot, "main.xml"),
    path.join(options.output, "app/src/main/AndroidManifest.xml"),
  );
  options.inPlace = true;
  generate();
  const marker = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-host.json")),
  );
  assert.equal(marker.output, "android");
  // Renaming the checkout moves the marker with the files it lists.
  const moved = `${options.consumerRoot}-moved`;
  fs.renameSync(options.consumerRoot, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  options.consumerRoot = moved;
  options.output = path.join(moved, "android");
  const result = generate();
  assert.equal(result.directory, path.join(fs.realpathSync(moved), "android"));
  const profile = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  assert.equal(
    profile.manifest,
    path.join(
      fs.realpathSync(moved),
      "android/app/src/main/AndroidManifest.xml",
    ),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(options.output, ".eliza-consumer-host.json")),
    ).consumerRoot,
    fs.realpathSync(moved),
  );
  // The same marker at another place in the consumer owns nothing there.
  const copy = path.join(moved, "copy");
  fs.mkdirSync(copy);
  fs.copyFileSync(
    path.join(options.output, ".eliza-consumer-host.json"),
    path.join(copy, ".eliza-consumer-host.json"),
  );
  fs.writeFileSync(path.join(copy, "build.gradle"), "authored");
  options.output = copy;
  assert.throws(generate, /ownership differs/);
  assert.equal(
    fs.readFileSync(path.join(copy, "build.gradle"), "utf8"),
    "authored",
  );
  // A marker without a recorded place is matched by its absolute consumer root only.
  options.output = path.join(moved, "android");
  const markerPath = path.join(options.output, ".eliza-consumer-host.json");
  const legacy = JSON.parse(fs.readFileSync(markerPath));
  delete legacy.output;
  fs.writeFileSync(markerPath, JSON.stringify(legacy));
  generate();
  delete legacy.output;
  legacy.consumerRoot = path.join(os.tmpdir(), "elsewhere");
  fs.writeFileSync(markerPath, JSON.stringify(legacy));
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
    (p) => (p.androidResources = { noCompress: ["../gguf"] }),
  ]) {
    const { options, generate } = setup(t);
    mutate(options.profile);
    assert.throws(generate, AndroidConsumerHostError);
    assert.equal(fs.existsSync(options.output), false);
  }
});
test("toolchain is hash pinned and optional runtime preserves exact native bytes", (t) => {
  const { options, generate } = setup(t);
  options.profile.androidResources = { noCompress: ["gguf", "lex"] };
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
  assert.deepEqual(normalized.noCompress, ["gguf", "lex"]);
  assert.equal(
    normalized.buildConfigFields[0].value,
    JSON.stringify('host "literal" $value'),
  );
  assert.equal(normalized.preserveRuntimeBytes, true);
  // A staged runtime cannot be packaged with stripped libraries.
  options.profile.preserveRuntimeBytes = false;
  assert.throws(generate, /requires runtime byte preservation/);
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
    {
      name: "shared",
      source: { root: "upstream", path: "packages/app/scripts/mobile/android" },
    },
    {
      name: "staged",
      source: { root: "consumer", path: "src" },
      relocateBuild: true,
    },
  ];
  generate();
  const profile = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  assert.deepEqual(
    profile.modules.map(({ name, appDependency, relocateBuild }) => ({
      name,
      appDependency,
      relocateBuild,
    })),
    [
      { name: "library", appDependency: true, relocateBuild: false },
      { name: "updater", appDependency: false, relocateBuild: false },
      { name: "shared", appDependency: true, relocateBuild: true },
      { name: "staged", appDependency: true, relocateBuild: true },
    ],
  );
  options.profile.modules[3].relocateBuild = "yes";
  assert.throws(generate, /relocateBuild must be a boolean/);
  options.profile.modules.splice(2, 2);
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

test("an in-place host sits beside authored sources and never replaces one", (t) => {
  const { options, generate } = setup(t);
  // The consumer's own Android directory: authored manifests and sources stay put.
  const authored = path.join(options.output, "app/src/main");
  fs.mkdirSync(path.join(authored, "java"), { recursive: true });
  fs.copyFileSync(
    path.join(options.consumerRoot, "main.xml"),
    path.join(authored, "AndroidManifest.xml"),
  );
  fs.writeFileSync(path.join(options.output, "README.md"), "authored");
  options.profile.manifest = {
    root: "consumer",
    path: "android/app/src/main/AndroidManifest.xml",
  };
  assert.throws(generate, /unowned Android project/);
  options.inPlace = true;
  const result = generate();
  // The in-place main manifest is used where it is; the external launcher manifest is copied.
  assert.deepEqual(
    result.files.filter((file) => file.endsWith("AndroidManifest.xml")),
    ["app/src/launcher/AndroidManifest.xml"],
  );
  assert.equal(
    fs.readFileSync(path.join(options.output, "README.md"), "utf8"),
    "authored",
  );
  const profile = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  assert.equal(
    profile.manifest,
    fs.realpathSync(path.join(authored, "AndroidManifest.xml")),
  );
  assert.equal(
    profile.flavors.find(({ name }) => name === "launcher").manifest,
    path.join(
      fs.realpathSync(options.output),
      "app/src/launcher/AndroidManifest.xml",
    ),
  );
  assert.match(
    fs.readFileSync(
      path.join(
        options.output,
        "eliza-consumer-host/res/values/eliza_consumer_identity.xml",
      ),
      "utf8",
    ),
    /name="app_name"/,
  );
  generate();
  // A later authored build script is never adopted or replaced.
  fs.unlinkSync(path.join(options.output, ".eliza-consumer-host.json"));
  fs.writeFileSync(path.join(options.output, "build.gradle"), "authored");
  assert.throws(generate, /unowned generated-file collision/);
  assert.equal(
    fs.readFileSync(path.join(options.output, "build.gradle"), "utf8"),
    "authored",
  );
});

test("a formerly generated manifest adopted in place survives regeneration", (t) => {
  const { options, generate } = setup(t);
  // First generation copies an external main manifest into the host.
  const copied = path.join(options.output, "app/src/main/AndroidManifest.xml");
  generate();
  assert.ok(fs.existsSync(copied));
  // The consumer then authors that same path and points the profile at it.
  fs.writeFileSync(copied, "<manifest><!-- authored --></manifest>");
  options.profile.manifest = {
    root: "consumer",
    path: "android/app/src/main/AndroidManifest.xml",
  };
  options.inPlace = true;
  const result = generate();
  assert.equal(
    fs.readFileSync(copied, "utf8"),
    "<manifest><!-- authored --></manifest>",
  );
  // The authored file is no longer generator-owned.
  assert.equal(
    result.files.includes("app/src/main/AndroidManifest.xml"),
    false,
  );
  generate();
  assert.equal(
    fs.readFileSync(copied, "utf8"),
    "<manifest><!-- authored --></manifest>",
  );
});

test("release signing and version overrides are environment names only", (t) => {
  const { options, generate } = setup(t);
  options.profile.signing = {
    storeFile: "HOST_KEYSTORE_PATH",
    storePassword: "HOST_KEYSTORE_PASSWORD",
    keyAlias: "HOST_KEY_ALIAS",
    keyPassword: "HOST_KEY_PASSWORD",
  };
  options.profile.versionOverride = {
    versionCode: "HOST_VERSION_CODE",
    versionName: "HOST_VERSION_NAME",
  };
  generate();
  const profile = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  assert.deepEqual(profile.signing, options.profile.signing);
  assert.deepEqual(profile.versionOverride, options.profile.versionOverride);
  const gradle = fs.readFileSync(
    path.join(options.output, "app/build.gradle"),
    "utf8",
  );
  assert.match(
    gradle,
    /incomplete signing environment\. Missing: \$\{missing\.join/,
  );
  assert.match(
    gradle,
    /if \(hostSigning\) signingConfig signingConfigs\.release/,
  );
  for (const mutate of [
    (p) => (p.signing.keyAlias = p.signing.keyPassword),
    (p) => (p.signing.storeFile = "lower_case"),
    (p) => delete p.signing.storePassword,
    (p) => (p.signing.extra = "HOST_EXTRA"),
    (p) => (p.versionOverride.versionName = "1.0"),
  ]) {
    const { options: next, generate: again } = setup(t);
    next.profile.signing = structuredClone(options.profile.signing);
    next.profile.versionOverride = structuredClone(
      options.profile.versionOverride,
    );
    mutate(next.profile);
    assert.throws(again, AndroidConsumerHostError);
    assert.equal(fs.existsSync(next.output), false);
  }
  options.identity.version = "1.0 beta";
  assert.throws(generate, /version or name/);
});

test("build types, test mocks, admission and staged assets are normalized data", (t) => {
  const { options, generate } = setup(t);
  const source = (relative) => ({ root: "consumer", path: relative });
  fs.mkdirSync(path.join(options.consumerRoot, "mocks/java"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(options.consumerRoot, "mocks/main.xml"),
    "<manifest/>",
  );
  fs.writeFileSync(
    path.join(options.consumerRoot, "rules.pro"),
    "-keep class x",
  );
  fs.writeFileSync(path.join(options.consumerRoot, "receipt.json"), "{}");
  fs.writeFileSync(path.join(options.consumerRoot, "product.gradle"), "");
  Object.assign(options.profile, {
    releaseMinify: true,
    kotlin: false,
    preserveRuntimeBytes: true,
    buildTypes: {
      debug: { abiFilters: ["arm64-v8a", "x86_64"] },
      release: {
        abiFilters: ["arm64-v8a"],
        shrinkResources: true,
        proguardFiles: [source("rules.pro")],
      },
    },
    testMocks: {
      property: "HOST_TEST_MOCKS",
      buildConfigField: "HOST_TEST_MOCKS",
      debug: {
        java: [source("mocks/java")],
        manifest: source("mocks/main.xml"),
      },
    },
    admission: [
      {
        name: "verifyInputs",
        command: ["node", "check.mjs"],
        directory: source("src"),
      },
      {
        name: "verifyRoot",
        command: ["node", "root.mjs"],
        directory: source("."),
      },
    ],
    settingsAdmission: [
      { command: ["node", "stage.mjs"], directory: source("src") },
    ],
    generatedSources: [
      { sourceSet: "main", kind: "java", path: "generated/host/java" },
    ],
    assetFiles: [{ source: source("receipt.json"), name: "receipt.json" }],
    appScripts: [source("product.gradle")],
    generationInputs: [source("receipt.json")],
    dependencies: [
      {
        configuration: "implementation",
        module: "androidx.webkit:webkit",
        toolchainVersion: "androidxWebkitVersion",
      },
    ],
  });
  generate();
  const profile = JSON.parse(
    fs.readFileSync(path.join(options.output, ".eliza-consumer-profile.json")),
  );
  const real = (relative) =>
    fs.realpathSync(path.join(options.consumerRoot, relative));
  assert.equal(profile.kotlin, false);
  assert.equal(profile.preserveRuntimeBytes, true);
  assert.deepEqual(profile.buildTypes.release.proguardFiles, [
    real("rules.pro"),
  ]);
  assert.deepEqual(profile.testMocks.debug, {
    java: [real("mocks/java")],
    res: [],
    manifest: real("mocks/main.xml"),
  });
  assert.deepEqual(profile.admission, [
    {
      name: "verifyInputs",
      command: ["node", "check.mjs"],
      directory: real("src"),
    },
    {
      name: "verifyRoot",
      command: ["node", "root.mjs"],
      directory: fs.realpathSync(options.consumerRoot),
    },
  ]);
  assert.deepEqual(profile.assetFiles, [
    { source: real("receipt.json"), name: "receipt.json" },
  ]);
  assert.deepEqual(profile.generationInputs, [
    {
      file: real("receipt.json"),
      sha256:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    },
  ]);
  assert.deepEqual(profile.dependencies, [
    {
      configuration: "implementation",
      coordinate: `androidx.webkit:webkit:${profile.toolchain.versions.androidxWebkitVersion}`,
    },
  ]);
  const gradle = fs.readFileSync(
    path.join(options.output, "app/build.gradle"),
    "utf8",
  );
  assert.match(gradle, /keepDebugSymbols/);
  assert.match(gradle, /apply from: script/);
  assert.match(
    fs.readFileSync(path.join(options.output, "settings.gradle"), "utf8"),
    /Generated Android host is stale/,
  );
  for (const mutate of [
    (p) => (p.buildTypes.release.abiFilters = ["mips"]),
    (p) => (p.buildTypes.debug.abiFilters = []),
    (p) => (p.buildTypes.release.minify = true),
    (p) => {
      p.releaseMinify = false;
      p.buildTypes.release.proguardFiles = [];
      delete p.buildTypes.release.shrinkResources;
    },
    (p) => {
      p.releaseMinify = false;
      delete p.buildTypes.release.proguardFiles;
    },
    (p) => (p.testMocks.property = "lower"),
    (p) => (p.testMocks.debug.assets = []),
    (p) => (p.admission[0].name = "preBuild"),
    (p) => p.admission.push({ ...p.admission[0] }),
    (p) => (p.admission[0].command = []),
    (p) => (p.admission[0].command = ["node", ""]),
    (p) => (p.settingsAdmission[0].directory = source("missing")),
    (p) => (p.assetFiles[0].source = source(".")),
    (p) => (p.admission[1].directory = source("./")),
    (p) => (p.generatedSources[0].path = "outside/java"),
    (p) => (p.generatedSources[0].kind = "manifest"),
    (p) => p.assetFiles.push({ ...p.assetFiles[0] }),
    (p) => (p.assetFiles[0].name = "../escape.json"),
    (p) => (p.appScripts = [source("receipt.json")]),
    (p) => (p.dependencies[0].toolchainVersion = "unknownVersion"),
    (p) => (p.dependencies[0].coordinate = "androidx.webkit:webkit:1.0.0"),
    (p) => (p.kotlin = "false"),
  ]) {
    const next = structuredClone(options.profile);
    mutate(next);
    assert.throws(
      () =>
        generateAndroidConsumerHost({
          ...options,
          output: path.join(options.consumerRoot, "other"),
          profile: next,
        }),
      AndroidConsumerHostError,
    );
    assert.equal(
      fs.existsSync(path.join(options.consumerRoot, "other")),
      false,
    );
  }
});

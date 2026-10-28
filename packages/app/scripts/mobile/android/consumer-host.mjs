/** Generates an owned external Android host without copying another product's app tree. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectAndroidRuntimeBytePreservation } from "../../lib/android-runtime-packaging.ts";

const templates = fileURLToPath(new URL("./consumer-host/", import.meta.url));
const markerName = ".eliza-consumer-host.json";
/** Generator-owned resources (the brand string) live here, never in host resource directories. */
const CONSUMER_IDENTITY_RESOURCES = "eliza-consumer-host/res";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, value) =>
  value === root || value.startsWith(root + path.sep);
const namePattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const environmentName = /^[A-Z][A-Z0-9_]*$/;
const taskName = /^[a-z][A-Za-z0-9]*$/;
/** Plain release labels: one rule for the generated identity and its environment override. */
const VERSION_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const ANDROID_ABIS = Object.freeze([
  "arm64-v8a",
  "armeabi-v7a",
  "x86",
  "x86_64",
  "riscv64",
]);
/** The release-signing inputs a profile names: environment variable names, never values. */
const RELEASE_SIGNING_KEYS = Object.freeze([
  "storeFile",
  "storePassword",
  "keyAlias",
  "keyPassword",
]);
const sourceKinds = ["java", "kotlin", "assets", "res", "jniLibs"];
const dependencyConfigurations = [
  "implementation",
  "androidTestImplementation",
  "testImplementation",
];
export class AndroidConsumerHostError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AndroidConsumerHostError";
  }
}
const requireValue = (condition, message) => {
  if (!condition) throw new AndroidConsumerHostError(message);
};
function relativePath(value) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Expected a repository-relative host path",
  );
  return value;
}
function fields(values = []) {
  requireValue(Array.isArray(values), "BuildConfig fields must be an array");
  const names = new Set();
  return values.map((field) => {
    requireValue(
      field && /^[A-Z][A-Z0-9_]*$/.test(field.name) && !names.has(field.name),
      "Invalid or duplicate BuildConfig field",
    );
    names.add(field.name);
    requireValue(
      (field.type === "boolean" && typeof field.value === "boolean") ||
        (field.type === "int" &&
          Number.isSafeInteger(field.value) &&
          field.value >= -2147483648 &&
          field.value <= 2147483647) ||
        (field.type === "String" && typeof field.value === "string"),
      "BuildConfig field has an invalid Java value",
    );
    return { ...field, value: JSON.stringify(field.value) };
  });
}
function abis(values, where) {
  requireValue(
    values === undefined ||
      (Array.isArray(values) &&
        values.length > 0 &&
        new Set(values).size === values.length &&
        values.every((abi) => ANDROID_ABIS.includes(abi))),
    `${where} ABI filters must name distinct supported ABIs`,
  );
  return values ?? [];
}
function onlyKeys(value, allowed, where) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${where} must be an object`,
  );
  for (const key of Object.keys(value))
    requireValue(
      allowed.includes(key),
      `${where} has unsupported field ${key}`,
    );
  return value;
}
function environmentNames(value, keys, where) {
  if (value === undefined) return null;
  onlyKeys(value, keys, where);
  const names = keys.map((key) => value[key]);
  requireValue(
    names.every((name) => environmentName.test(name ?? "")) &&
      new Set(names).size === names.length,
    `${where} must name ${keys.length} distinct environment variables`,
  );
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

/**
 * All policy is explicit data: identity, selected modules/sources, manifests,
 * resources, variants, signing/version environment names and BuildConfig values.
 * Paths are admitted against named caller roots. Output must be an owned
 * generated directory outside upstream. `inPlace` admits the consumer's own
 * authored Android directory as the output: generated build files sit beside
 * authored sources, and no unowned file is ever replaced.
 */
export function generateAndroidConsumerHost({
  consumerRoot,
  upstreamRoot,
  dependencyRoot,
  output,
  identity,
  profile,
  runtimeDirectory,
  inPlace = false,
}) {
  requireValue(typeof inPlace === "boolean", "inPlace must be a boolean");
  const requestedConsumerRoot = path.resolve(consumerRoot);
  consumerRoot = fs.realpathSync(consumerRoot);
  upstreamRoot = fs.realpathSync(upstreamRoot);
  const roots = { consumer: consumerRoot, upstream: upstreamRoot };
  if (dependencyRoot) roots.dependencies = fs.realpathSync(dependencyRoot);
  output = path.resolve(output);
  if (inside(requestedConsumerRoot, output)) {
    output = path.resolve(
      consumerRoot,
      path.relative(requestedConsumerRoot, output),
    );
  }
  requireValue(
    inside(consumerRoot, output) &&
      output !== consumerRoot &&
      !inside(upstreamRoot, output),
    "Generated host must be inside the consumer and outside upstream source",
  );
  // Reject symlink ancestors before creating anything under the output path.
  for (
    let cursor = output;
    cursor !== consumerRoot;
    cursor = path.dirname(cursor)
  ) {
    if (
      fs.existsSync(cursor) ||
      fs.lstatSync(cursor, { throwIfNoEntry: false })
    )
      requireValue(
        !fs.lstatSync(cursor).isSymbolicLink(),
        "Generated host ancestors must not be symlinks",
      );
  }
  requireValue(
    !fs.existsSync(output) || fs.statSync(output).isDirectory(),
    "Generated Android output must be a directory",
  );
  requireValue(
    identity && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(identity.appId),
    "Invalid Android application identity",
  );
  requireValue(
    typeof identity.appName === "string" &&
      identity.appName.trim() &&
      [...identity.appName].every(
        (character) =>
          character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127,
      ) &&
      typeof identity.version === "string" &&
      VERSION_NAME_PATTERN.test(identity.version) &&
      Number.isSafeInteger(identity.versionCode) &&
      identity.versionCode > 0 &&
      identity.versionCode <= 2100000000,
    "Invalid Android application version or name",
  );
  requireValue(profile?.schema === 1, "Unsupported Android consumer profile");
  requireValue(
    profile.sdk &&
      ["min", "target", "compile"].every(
        (key) => Number.isSafeInteger(profile.sdk[key]) && profile.sdk[key] > 0,
      ) &&
      profile.sdk.min <= profile.sdk.target &&
      profile.sdk.target <= profile.sdk.compile,
    "Invalid Android SDK profile",
  );
  requireValue(
    typeof profile.releaseMinify === "boolean",
    "Release minification policy must be explicit",
  );
  requireValue(
    profile.kotlin === undefined || typeof profile.kotlin === "boolean",
    "Kotlin selection must be a boolean",
  );
  requireValue(
    profile.preserveRuntimeBytes === undefined ||
      typeof profile.preserveRuntimeBytes === "boolean",
    "Runtime byte preservation must be a boolean",
  );
  function input(reference, kind) {
    requireValue(
      reference && Object.hasOwn(roots, reference.root),
      "Unknown Android host source root",
    );
    const root = roots[reference.root];
    // "." names a declared root itself, for example an admission working directory.
    const requested =
      reference.path === "." && kind === "directory"
        ? root
        : path.join(root, relativePath(reference.path));
    let candidate;
    try {
      candidate = fs.realpathSync(requested);
    } catch (cause) {
      throw new AndroidConsumerHostError("Android host input is unavailable", {
        cause,
      });
    }
    requireValue(
      inside(root, candidate),
      "Android host input escapes its declared root",
    );
    const stat = fs.statSync(candidate);
    requireValue(
      kind === "file" ? stat.isFile() : stat.isDirectory(),
      `Android host input must be a ${kind}`,
    );
    return candidate;
  }
  const toolchain = JSON.parse(
    fs.readFileSync(path.join(templates, "toolchain.json")),
  );
  const files = new Map();
  function add(relative, bytes, mode = 0o644) {
    relativePath(relative);
    requireValue(!files.has(relative), "Duplicate generated Android host path");
    files.set(relative, { bytes: Buffer.from(bytes), mode });
  }
  requireValue(
    Array.isArray(profile.modules),
    "Native modules must be explicit",
  );
  const moduleNames = new Set();
  const modules = profile.modules.map((module) => {
    requireValue(
      namePattern.test(module.name) &&
        module.name !== "app" &&
        !moduleNames.has(module.name),
      "Invalid or duplicate native module",
    );
    requireValue(
      module.appDependency === undefined ||
        typeof module.appDependency === "boolean",
      "Native module appDependency must be a boolean",
    );
    requireValue(
      module.relocateBuild === undefined ||
        typeof module.relocateBuild === "boolean",
      "Native module relocateBuild must be a boolean",
    );
    moduleNames.add(module.name);
    return {
      name: module.name,
      directory: input(module.source, "directory"),
      appDependency: module.appDependency ?? true,
      // Upstream and dependency trees are immutable inputs; consumers opt in for staged copies.
      relocateBuild: module.relocateBuild ?? module.source.root !== "consumer",
    };
  });
  requireValue(
    Array.isArray(profile.flavors) && profile.flavors.length > 0,
    "Distribution variants must be explicit",
  );
  // A manifest already at its source-set location in an in-place host is used where it is;
  // any other manifest is copied into the generated app module, where lint resolves its classes.
  const manifestFor = (reference, sourceSet) => {
    const source = input(reference, "file");
    const relative = `app/src/${sourceSet}/AndroidManifest.xml`;
    const destination = path.join(output, relative);
    if (source !== destination) add(relative, fs.readFileSync(source));
    return destination;
  };
  const flavors = [],
    sourceNames = new Set(["main", "androidTest", "debug", "release"]);
  for (const flavor of profile.flavors) {
    requireValue(
      namePattern.test(flavor.name) &&
        !sourceNames.has(flavor.name) &&
        !["debug", "release", "test"].includes(flavor.name),
      "Invalid or duplicate distribution variant",
    );
    sourceNames.add(flavor.name);
    flavors.push({
      name: flavor.name,
      buildConfigFields: fields(flavor.buildConfigFields),
      manifest: flavor.manifest
        ? manifestFor(flavor.manifest, flavor.name)
        : null,
    });
  }
  // Android escaping follows XML decoding; quotes preserve whitespace and apostrophes.
  // https://developer.android.com/guide/topics/resources/string-resource#escaping_quotes
  const label = `"${identity.appName.replace(/[\\"@?]/g, (character) => `\\${character}`)}"`;
  const xmlLabel = label
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  add(
    `${CONSUMER_IDENTITY_RESOURCES}/values/eliza_consumer_identity.xml`,
    `<resources><string name="app_name" formatted="false" translatable="false">${xmlLabel}</string></resources>\n`,
  );
  const manifest = manifestFor(profile.manifest, "main");
  const sourceSets = {};
  for (const [name, sources] of Object.entries(profile.sourceSets ?? {})) {
    requireValue(sourceNames.has(name), "Undeclared Android source set");
    sourceSets[name] = {};
    for (const [kind, references] of Object.entries(sources)) {
      requireValue(
        sourceKinds.includes(kind) && Array.isArray(references),
        "Invalid Android source kind",
      );
      sourceSets[name][kind] = references.map((reference) =>
        input(reference, "directory"),
      );
    }
  }
  for (const file of profile.sourceFiles ?? []) {
    requireValue(
      sourceNames.has(file.sourceSet) &&
        ["java", "kotlin"].includes(file.language),
      "Invalid selected native source",
    );
    const source = input(file.source, "file");
    requireValue(
      path.extname(source) === (file.language === "java" ? ".java" : ".kt"),
      "Selected native source language differs",
    );
    add(
      `app/src/${file.sourceSet}/${file.language}/${path.basename(source)}`,
      fs.readFileSync(source),
    );
  }
  // Directories an admission task produces during the build, relative to the
  // app build directory.
  const generatedSources = (profile.generatedSources ?? []).map((entry) => {
    onlyKeys(entry, ["sourceSet", "kind", "path"], "Generated source");
    requireValue(
      sourceNames.has(entry.sourceSet) && sourceKinds.includes(entry.kind),
      "Invalid generated Android source",
    );
    requireValue(
      relativePath(entry.path).startsWith("generated/"),
      "Generated Android sources must live under the build generated directory",
    );
    return { sourceSet: entry.sourceSet, kind: entry.kind, path: entry.path };
  });
  requireValue(
    Array.isArray(profile.dependencies),
    "Android dependencies must be explicit",
  );
  const dependencies = profile.dependencies.map((dependency) => {
    let coordinate = dependency.coordinate;
    if (dependency.toolchainVersion !== undefined) {
      // Shared AndroidX libraries take the reviewed toolchain version.
      requireValue(
        coordinate === undefined &&
          /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(dependency.module ?? "") &&
          Object.hasOwn(toolchain.versions, dependency.toolchainVersion),
        "Toolchain dependency requires a module and a reviewed version name",
      );
      coordinate = `${dependency.module}:${toolchain.versions[dependency.toolchainVersion]}`;
    } else
      requireValue(
        dependency.module === undefined,
        "Only a toolchain dependency names a module without a version",
      );
    requireValue(
      dependencyConfigurations.includes(dependency.configuration) &&
        /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(
          coordinate ?? "",
        ) &&
        !/^latest(?:\.|$)|-SNAPSHOT$/i.test(coordinate.split(":")[2]),
      "Android dependency requires a fixed coordinate",
    );
    return { configuration: dependency.configuration, coordinate };
  });
  // Asset extensions the APK stores without compression, for example models
  // that the app copies or maps from the APK (paradee-voice: gguf and lex).
  const noCompress = profile.androidResources?.noCompress ?? [];
  requireValue(
    Array.isArray(noCompress) &&
      noCompress.every((extension) => /^[a-z0-9]+$/.test(extension)),
    "Uncompressed asset extensions must be plain names",
  );
  const manifestPlaceholders = profile.manifestPlaceholders ?? {};
  requireValue(
    Object.entries(manifestPlaceholders).every(
      ([key, value]) => namePattern.test(key) && typeof value === "string",
    ),
    "Manifest placeholders must be string values",
  );
  const buildTypes = onlyKeys(
    profile.buildTypes ?? {},
    ["debug", "release"],
    "Build types",
  );
  const debug = onlyKeys(
    buildTypes.debug ?? {},
    ["abiFilters", "buildConfigFields"],
    "Debug build type",
  );
  const release = onlyKeys(
    buildTypes.release ?? {},
    ["abiFilters", "buildConfigFields", "shrinkResources", "proguardFiles"],
    "Release build type",
  );
  requireValue(
    release.shrinkResources === undefined ||
      (typeof release.shrinkResources === "boolean" &&
        (!release.shrinkResources || profile.releaseMinify)),
    "Resource shrinking requires release minification",
  );
  requireValue(
    release.proguardFiles === undefined ||
      (Array.isArray(release.proguardFiles) && profile.releaseMinify),
    "Proguard rules require release minification",
  );
  const normalizedBuildTypes = {
    debug: {
      abiFilters: abis(debug.abiFilters, "Debug"),
      buildConfigFields: fields(debug.buildConfigFields),
    },
    release: {
      abiFilters: abis(release.abiFilters, "Release"),
      buildConfigFields: fields(release.buildConfigFields),
      shrinkResources: release.shrinkResources ?? false,
      proguardFiles: (release.proguardFiles ?? []).map((reference) =>
        input(reference, "file"),
      ),
    },
  };
  // Release signing reads these environment variables in Gradle: all or none.
  const signing = environmentNames(
    profile.signing,
    RELEASE_SIGNING_KEYS,
    "Release signing",
  );
  const versionOverride = environmentNames(
    profile.versionOverride,
    ["versionCode", "versionName"],
    "Version override",
  );
  // Test-only sources attach to debug variants only when the switch is exactly "1".
  let testMocks = null;
  if (profile.testMocks !== undefined) {
    onlyKeys(
      profile.testMocks,
      ["property", "buildConfigField", "debug", "androidTest"],
      "Test mocks",
    );
    requireValue(
      environmentName.test(profile.testMocks.property ?? "") &&
        (profile.testMocks.buildConfigField === undefined ||
          /^[A-Z][A-Z0-9_]*$/.test(profile.testMocks.buildConfigField)),
      "Test mocks require a switch name",
    );
    const debugSources = onlyKeys(
      profile.testMocks.debug ?? {},
      ["java", "res", "manifest"],
      "Test mock debug sources",
    );
    const androidTest = onlyKeys(
      profile.testMocks.androidTest ?? {},
      ["java"],
      "Test mock instrumentation sources",
    );
    const directories = (references) => {
      requireValue(
        references === undefined || Array.isArray(references),
        "Test mock sources must be lists",
      );
      return (references ?? []).map((reference) =>
        input(reference, "directory"),
      );
    };
    testMocks = {
      property: profile.testMocks.property,
      buildConfigField: profile.testMocks.buildConfigField ?? null,
      debug: {
        java: directories(debugSources.java),
        res: directories(debugSources.res),
        manifest: debugSources.manifest
          ? input(debugSources.manifest, "file")
          : null,
      },
      androidTest: { java: directories(androidTest.java) },
    };
  }
  // Admission commands run as argv without a shell.
  const command = (step, where) => {
    requireValue(
      Array.isArray(step.command) &&
        step.command.length > 0 &&
        step.command.every(
          (argument) => typeof argument === "string" && argument.length > 0,
        ),
      `${where} requires an argv command`,
    );
    return {
      command: [...step.command],
      directory: input(step.directory, "directory"),
    };
  };
  const admissionNames = new Set(["preBuild", "stageElizaConsumerAssetFiles"]);
  const admission = (profile.admission ?? []).map((step) => {
    onlyKeys(step, ["name", "command", "directory"], "Admission task");
    requireValue(
      taskName.test(step.name ?? "") && !admissionNames.has(step.name),
      "Admission tasks need distinct task names",
    );
    admissionNames.add(step.name);
    return { name: step.name, ...command(step, "Admission task") };
  });
  const settingsAdmission = (profile.settingsAdmission ?? []).map((step) => {
    onlyKeys(step, ["command", "directory"], "Settings admission");
    return command(step, "Settings admission");
  });
  const assetNames = new Set();
  const assetFiles = (profile.assetFiles ?? []).map((asset) => {
    onlyKeys(asset, ["source", "name"], "Asset file");
    requireValue(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name ?? "") &&
        !assetNames.has(asset.name),
      "Asset files need distinct plain names",
    );
    assetNames.add(asset.name);
    return { source: input(asset.source, "file"), name: asset.name };
  });
  const appScripts = (profile.appScripts ?? []).map((reference) => {
    const script = input(reference, "file");
    requireValue(
      path.extname(script) === ".gradle",
      "App scripts must be Gradle files",
    );
    return script;
  });
  // A host generated from inputs that changed later refuses to configure.
  const generationInputs = (profile.generationInputs ?? []).map((reference) => {
    const file = input(reference, "file");
    return { file, sha256: hash(fs.readFileSync(file)) };
  });
  let runtimeMain = null;
  if (runtimeDirectory) {
    runtimeMain = fs.realpathSync(
      path.join(runtimeDirectory, "android/app/src/main"),
    );
    for (const file of [
      "assets/agent/agent-bundle.js",
      "assets/agent-runtime.inventory",
    ])
      requireValue(
        fs.statSync(path.join(runtimeMain, file)).isFile(),
        "Android runtime payload is incomplete",
      );
  }
  const normalized = {
    identity,
    toolchain,
    sdk: profile.sdk,
    releaseMinify: profile.releaseMinify,
    kotlin: profile.kotlin ?? true,
    preserveRuntimeBytes: Boolean(profile.preserveRuntimeBytes || runtimeMain),
    modules,
    manifest,
    identityResources: path.join(output, CONSUMER_IDENTITY_RESOURCES),
    flavors,
    sourceSets,
    generatedSources,
    dependencies,
    manifestPlaceholders,
    noCompress,
    buildConfigFields: fields(profile.buildConfigFields),
    buildTypes: normalizedBuildTypes,
    signing,
    versionOverride,
    testMocks,
    admission,
    settingsAdmission,
    assetFiles,
    appScripts,
    generationInputs,
    runtimeMain,
  };
  add(
    ".eliza-consumer-profile.json",
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  for (const name of ["build.gradle", "settings.gradle"])
    add(name, fs.readFileSync(path.join(templates, name)));
  let appGradle = fs.readFileSync(path.join(templates, "app.gradle"), "utf8");
  if (normalized.preserveRuntimeBytes)
    appGradle = injectAndroidRuntimeBytePreservation(appGradle);
  add("app/build.gradle", appGradle);
  add(
    "gradle.properties",
    "org.gradle.jvmargs=-Xmx2048m\nandroid.useAndroidX=true\norg.gradle.parallel=false\norg.gradle.workers.max=2\n",
  );
  const platform = path.join(upstreamRoot, "packages/app/platforms/android");
  const wrapper = fs.readFileSync(
    path.join(platform, "gradle/wrapper/gradle-wrapper.jar"),
  );
  requireValue(
    hash(wrapper) === toolchain.wrapperSha256,
    "Upstream Gradle wrapper differs from the reviewed consumer toolchain",
  );
  add("gradle/wrapper/gradle-wrapper.jar", wrapper);
  for (const name of ["gradlew", "gradlew.bat"])
    add(
      name,
      fs.readFileSync(path.join(platform, name)),
      name === "gradlew" ? 0o755 : 0o644,
    );
  add(
    "gradle/wrapper/gradle-wrapper.properties",
    `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${toolchain.gradle}-bin.zip\nnetworkTimeout=10000\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\ndistributionSha256Sum=${toolchain.gradleSha256}\n`,
  );
  const markerPath = path.join(output, markerName);
  // Ownership is the output's place in the consumer: the marker moves with the
  // files it lists, so a moved or renamed checkout still owns its generated host,
  // while a marker copied to another place owns nothing there. A marker written
  // before places were recorded is matched by its absolute consumer root.
  const ownedOutput = path
    .relative(consumerRoot, output)
    .split(path.sep)
    .join("/");
  let previous = [];
  if (fs.lstatSync(markerPath, { throwIfNoEntry: false })) {
    requireValue(
      !fs.lstatSync(markerPath).isSymbolicLink(),
      "Refusing to overwrite an unowned Android project",
    );
    const marker = JSON.parse(fs.readFileSync(markerPath));
    requireValue(
      marker.schema === 1 &&
        (marker.output === undefined
          ? marker.consumerRoot === consumerRoot
          : marker.output === ownedOutput) &&
        marker.appId === identity.appId &&
        Array.isArray(marker.files),
      "Generated Android ownership differs",
    );
    previous = marker.files.map(relativePath);
  } else
    requireValue(
      inPlace || !fs.existsSync(output) || !fs.readdirSync(output).length,
      "Refusing to overwrite an unowned Android project",
    );
  // Do not follow symlinks or overwrite a file this generator does not own.
  for (const relative of new Set([...previous, ...files.keys()])) {
    const target = path.join(output, relative);
    for (
      let cursor = target;
      cursor !== output;
      cursor = path.dirname(cursor)
    ) {
      const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
      requireValue(
        !stat?.isSymbolicLink(),
        "Generated Android files must not be symlinks",
      );
    }
    if (fs.existsSync(target))
      requireValue(
        previous.includes(relative) && fs.statSync(target).isFile(),
        `Refusing an unowned generated-file collision: ${relative}`,
      );
  }
  fs.mkdirSync(output, { recursive: true });
  // The marker is written first: interrupted generation remains explicitly owned
  // and can be regenerated. No recursive deletion or host-source mutation occurs.
  const receipt = {
    schema: 1,
    consumerRoot,
    output: ownedOutput,
    appId: identity.appId,
    files: [...new Set([...previous, ...files.keys()])],
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(receipt, null, 2)}\n`);
  for (const [relative, { bytes, mode }] of files) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.chmodSync(target, mode);
  }
  for (const relative of previous)
    if (!files.has(relative) && fs.existsSync(path.join(output, relative)))
      fs.unlinkSync(path.join(output, relative));
  receipt.files = [...files.keys()];
  fs.writeFileSync(markerPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    directory: output,
    appId: identity.appId,
    files: receipt.files,
    toolchain: toolchain.gradle,
  };
}

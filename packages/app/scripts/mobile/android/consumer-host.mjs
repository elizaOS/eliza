/** Generates an owned external Android host without copying another product's app tree. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectAndroidRuntimeBytePreservation } from "../../lib/android-runtime-packaging.ts";

const templates = fileURLToPath(new URL("./consumer-host/", import.meta.url));
const markerName = ".eliza-consumer-host.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, value) =>
  value === root || value.startsWith(root + path.sep);
const namePattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
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

/**
 * All policy is explicit data: identity, selected modules/sources, manifests,
 * resources, variants and BuildConfig values. Paths are admitted against named
 * caller roots. Output must be an owned generated directory outside upstream.
 */
export function generateAndroidConsumerHost({
  consumerRoot,
  upstreamRoot,
  dependencyRoot,
  output,
  identity,
  profile,
  runtimeDirectory,
}) {
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
      identity.version.length > 0 &&
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
  function input(reference, kind) {
    requireValue(
      reference && Object.hasOwn(roots, reference.root),
      "Unknown Android host source root",
    );
    const root = roots[reference.root];
    const requested = path.join(root, relativePath(reference.path));
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
    moduleNames.add(module.name);
    return {
      name: module.name,
      directory: input(module.source, "directory"),
      appDependency: module.appDependency ?? true,
    };
  });
  requireValue(
    Array.isArray(profile.flavors) && profile.flavors.length > 0,
    "Distribution variants must be explicit",
  );
  const flavors = [],
    sourceNames = new Set(["main", "androidTest"]);
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
    });
    if (flavor.manifest)
      add(
        `app/src/${flavor.name}/AndroidManifest.xml`,
        fs.readFileSync(input(flavor.manifest, "file")),
      );
  }
  // Android escaping follows XML decoding; quotes preserve whitespace and apostrophes.
  // https://developer.android.com/guide/topics/resources/string-resource#escaping_quotes
  const label = `"${identity.appName.replace(/[\\"@?]/g, (character) => `\\${character}`)}"`;
  const xmlLabel = label
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  add(
    "app/src/main/res/values/eliza_consumer_identity.xml",
    `<resources><string name="app_name" formatted="false" translatable="false">${xmlLabel}</string></resources>\n`,
  );
  add(
    "app/src/main/AndroidManifest.xml",
    fs.readFileSync(input(profile.manifest, "file")),
  );
  const sourceSets = {};
  for (const [name, sources] of Object.entries(profile.sourceSets ?? {})) {
    requireValue(sourceNames.has(name), "Undeclared Android source set");
    sourceSets[name] = {};
    for (const [kind, references] of Object.entries(sources)) {
      requireValue(
        ["java", "kotlin", "assets", "res", "jniLibs"].includes(kind) &&
          Array.isArray(references),
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
  requireValue(
    Array.isArray(profile.dependencies),
    "Android dependencies must be explicit",
  );
  for (const dependency of profile.dependencies) {
    requireValue(
      [
        "implementation",
        "androidTestImplementation",
        "testImplementation",
      ].includes(dependency.configuration) &&
        /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(
          dependency.coordinate,
        ) &&
        !/^latest(?:\.|$)|-SNAPSHOT$/i.test(
          dependency.coordinate.split(":")[2],
        ),
      "Android dependency requires a fixed coordinate",
    );
  }
  const manifestPlaceholders = profile.manifestPlaceholders ?? {};
  requireValue(
    Object.entries(manifestPlaceholders).every(
      ([key, value]) => namePattern.test(key) && typeof value === "string",
    ),
    "Manifest placeholders must be string values",
  );
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
    modules,
    flavors,
    sourceSets,
    dependencies: profile.dependencies,
    manifestPlaceholders,
    buildConfigFields: fields(profile.buildConfigFields),
    runtimeMain,
  };
  add(
    ".eliza-consumer-profile.json",
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  for (const name of ["build.gradle", "settings.gradle"])
    add(name, fs.readFileSync(path.join(templates, name)));
  let appGradle = fs.readFileSync(path.join(templates, "app.gradle"), "utf8");
  if (runtimeMain) appGradle = injectAndroidRuntimeBytePreservation(appGradle);
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
  let previous = [];
  if (fs.existsSync(output) && fs.readdirSync(output).length) {
    requireValue(
      fs.existsSync(markerPath) && !fs.lstatSync(markerPath).isSymbolicLink(),
      "Refusing to overwrite an unowned Android project",
    );
    const marker = JSON.parse(fs.readFileSync(markerPath));
    requireValue(
      marker.schema === 1 &&
        marker.consumerRoot === consumerRoot &&
        marker.appId === identity.appId &&
        Array.isArray(marker.files),
      "Generated Android ownership differs",
    );
    previous = marker.files.map(relativePath);
  }
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
        "Refusing an unowned generated-file collision",
      );
  }
  fs.mkdirSync(output, { recursive: true });
  // The marker is written first: interrupted generation remains explicitly owned
  // and can be regenerated. No recursive deletion or host-source mutation occurs.
  const receipt = {
    schema: 1,
    consumerRoot,
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

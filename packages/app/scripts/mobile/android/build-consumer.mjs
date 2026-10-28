import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const safeRelative = (value, { allowEmpty = false } = {}) =>
  typeof value === "string" &&
  ((allowEmpty && value === "") ||
    (value.length > 0 &&
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value.split("/").every((part) => part && part !== "." && part !== "..")));
// Only project properties with plain values and offline resolution: no init scripts,
// no system properties and no verification switches.
const gradleArgument = (value) =>
  value === "--offline" ||
  /^-P[A-Za-z_][A-Za-z0-9_.]*=[A-Za-z0-9_.,:+-]*$/.test(value);
// Packaging intermediates that a sequential low-disk build discards between variants.
const PACKAGING_INTERMEDIATES = [
  "assets",
  "compressed_assets",
  "merged_native_libs",
  "merged_jni_libs",
  "stripped_native_libs",
];
// Files this build writes beside the artifacts and into the archive.
const RESERVED_OUTPUT_NAMES = [
  "apk-manifest.json",
  "service-mode.json",
  "build-checks.json",
];

/** Build selected distributions and archive only their verified artifacts.
 * Product hosts select identity, environment, admission commands and archive metadata.
 * Commands use argv without a shell. This does not install or publish APKs; a release
 * is signed only by the generated host's own signing configuration.
 * A prepare step is exactly one of: an argv command, a synchronous function called with
 * `{ root, environment }`, or `{ gradleTasks }`: extra tasks added to the one Gradle
 * invocation that builds the app. `lint` and `androidTest` (default true) select
 * `:app:lint` and the androidTest APKs; the archive's `build-checks.json` records both.
 * `project` is the Gradle project directory and `output` the artifact directory, both
 * relative to `root`. `gradleArguments` admits `-Pname=value` and `--offline` only.
 * A release named `<variant>-release.apk` is signed, otherwise `-release-unsigned.apk`;
 * when every `signing.environment` variable is set, an unsigned release fails the build.
 * `androidTestOutput` (relative to `output`, "" for `output` itself) retains each
 * `<variant>-androidTest.apk`; `mappings` retains R8 mappings under `output/mapping`;
 * `sequential` builds one variant/mode at a time and discards packaging intermediates
 * between them. `record` (`{ name, metadata }`, a plain `.json` name) is the host's
 * build record, written beside the artifacts only after every artifact of this build
 * is in place and before verification, so it always describes the artifacts beside it;
 * a failed Gradle build leaves the previous record with the previous artifacts, and a
 * copy interrupted after Gradle leaves no record. An archive
 * keeps a copy. `archive` is optional. */
export function buildAndroidConsumer({
  root = process.cwd(),
  environment = process.env,
  variants,
  prepare = [],
  verify,
  archive,
  record = null,
  daemon = false,
  lint = true,
  androidTest = true,
  project = "android",
  output = "artifacts",
  gradleArguments = [],
  androidTestOutput = null,
  signing = null,
  mappings = false,
  sequential = false,
  run = (command, args, options) => execFileSync(command, args, options),
}) {
  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    variants.some(
      (name) => typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(name),
    ) ||
    new Set(variants).size !== variants.length
  )
    throw new Error("Invalid Android distributions");
  if (
    [lint, androidTest, mappings, sequential, daemon].some(
      (value) => typeof value !== "boolean",
    )
  )
    throw new Error("Android lint and androidTest switches must be booleans");
  if (
    archive !== undefined &&
    archive !== null &&
    !/^[a-z][a-z0-9-]*$/.test(archive.name)
  )
    throw new Error("Invalid Android archive name");
  if (!safeRelative(project) || !safeRelative(output))
    throw new Error("Android project and output must be relative paths");
  if (
    androidTestOutput !== null &&
    !safeRelative(androidTestOutput, { allowEmpty: true })
  )
    throw new Error("Android test output must be a relative path");
  if (!Array.isArray(gradleArguments) || !gradleArguments.every(gradleArgument))
    throw new Error("Invalid Gradle argument");
  if (
    signing !== null &&
    !(
      Array.isArray(signing?.environment) &&
      signing.environment.length > 0 &&
      signing.environment.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
    )
  )
    throw new Error("Release signing must name environment variables");
  const isCommand = (command) =>
    command &&
    typeof command.command === "string" &&
    command.command &&
    Array.isArray(command.args) &&
    command.args.every((arg) => typeof arg === "string") &&
    !("gradleTasks" in command);
  const isGradleStep = (step) =>
    step &&
    Array.isArray(step.gradleTasks) &&
    step.gradleTasks.length > 0 &&
    step.gradleTasks.every(
      (task) =>
        typeof task === "string" &&
        /^:?[A-Za-z][\w.-]*(?::[A-Za-z][\w.-]*)*$/.test(task),
    ) &&
    !("command" in step);
  if (
    !Array.isArray(prepare) ||
    !isCommand(verify) ||
    prepare.some(
      (step) =>
        typeof step !== "function" && !isCommand(step) && !isGradleStep(step),
    )
  ) {
    throw new Error("Invalid Android admission command");
  }
  // Validate metadata before building or replacing any artifact.
  let metadata = null;
  if (archive !== undefined && archive !== null) {
    metadata = JSON.stringify(archive.metadata, null, 2);
    if (metadata === undefined)
      throw new Error("Android archive metadata is required");
  }
  let recordText = null;
  if (record !== null) {
    // The record cannot take a name the build itself writes beside the artifacts.
    if (
      typeof record?.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(record.name) ||
      RESERVED_OUTPUT_NAMES.includes(record.name)
    )
      throw new Error("Invalid Android build record name");
    recordText = JSON.stringify(record.metadata, null, 2);
    if (recordText === undefined)
      throw new Error("Android build record metadata is required");
  }
  root = path.resolve(root);
  const projectDirectory = path.join(root, project);
  const outputs = path.join(projectDirectory, "app/build/outputs");
  const outputDirectory = path.join(root, output);
  const signingRequested = Boolean(
    signing?.environment.every(
      (name) =>
        typeof environment[name] === "string" && environment[name].trim(),
    ),
  );
  const invoke = ({ command, args }, cwd = root) =>
    run(command, args, { cwd, env: environment, stdio: "inherit" });
  const extraTasks = [];
  for (const step of prepare) {
    if (typeof step === "function") {
      // An async step would race the Gradle build and could not stop publication.
      if (typeof step({ root, environment })?.then === "function")
        throw new Error("Android prepare functions must be synchronous");
    } else if (isGradleStep(step)) extraTasks.push(...step.gradleTasks);
    else invoke(step);
  }
  const capitalized = variants.map(
    (name) => name[0].toUpperCase() + name.slice(1),
  );
  // Signed/unsigned detection and mappings must see only this build's releases.
  for (const variant of variants) {
    fs.rmSync(path.join(outputs, "apk", variant, "release"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(outputs, "mapping", `${variant}Release`), {
      recursive: true,
      force: true,
    });
  }
  if (mappings)
    fs.rmSync(path.join(outputDirectory, "mapping"), {
      recursive: true,
      force: true,
    });
  if (androidTestOutput)
    fs.rmSync(path.join(outputDirectory, androidTestOutput), {
      recursive: true,
      force: true,
    });
  // An earlier verification must not outlive a failed or partly copied build:
  // only this invocation's verifier may leave a manifest beside the artifacts.
  const manifest = path.join(outputDirectory, "apk-manifest.json");
  fs.rmSync(manifest, { force: true });
  const gradle = (tasks) =>
    invoke(
      {
        command: "./gradlew",
        args: [
          daemon ? "--daemon" : "--no-daemon",
          ...gradleArguments,
          ...tasks,
        ],
      },
      projectDirectory,
    );
  if (sequential) {
    const intermediates = path.join(
      projectDirectory,
      "app/build/intermediates",
    );
    const discardIntermediates = () => {
      // Every ancestor is checked first; a linked category or ancestor is refused.
      const targets = PACKAGING_INTERMEDIATES.map((name) =>
        path.join(intermediates, name),
      );
      for (const target of targets) {
        let current = root;
        for (const segment of path.relative(root, target).split(path.sep)) {
          current = path.join(current, segment);
          const stat = fs.lstatSync(current, { throwIfNoEntry: false });
          if (!stat) break;
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("Unsafe packaging intermediate path");
        }
      }
      for (const target of targets)
        fs.rmSync(target, { recursive: true, force: true });
    };
    discardIntermediates();
    for (const name of capitalized)
      for (const mode of ["Debug", "Release"]) {
        try {
          gradle([
            `:app:assemble${name}${mode}`,
            ...(mode === "Debug" && androidTest
              ? [`:app:assemble${name}DebugAndroidTest`]
              : []),
          ]);
        } finally {
          discardIntermediates();
        }
      }
    if (lint || extraTasks.length)
      gradle([...extraTasks, ...(lint ? [":app:lint"] : [])]);
  } else {
    const modes = [
      "Debug",
      "Release",
      ...(androidTest ? ["DebugAndroidTest"] : []),
    ];
    gradle([
      ...modes.flatMap((mode) =>
        capitalized.map((name) => `:app:assemble${name}${mode}`),
      ),
      ...extraTasks,
      ...(lint ? [":app:lint"] : []),
    ]);
  }
  const artifacts = variants.flatMap((variant) =>
    ["debug", "release"].map((mode) => {
      const directory = path.join(outputs, "apk", variant, mode);
      const signed =
        mode === "release" &&
        fs.existsSync(path.join(directory, `app-${variant}-release.apk`));
      if (mode === "release" && signingRequested && !signed)
        throw new Error(
          `${signing.environment.join(", ")} are set but Gradle produced an unsigned ${variant} release`,
        );
      const name = `${variant}-${mode}${mode === "release" && !signed ? "-unsigned" : ""}.apk`;
      return {
        name,
        source: path.join(directory, `app-${name}`),
        variant,
        mode,
      };
    }),
  );
  // A missing variant cannot leave a mixed set copied from this build and a prior run.
  for (const artifact of artifacts)
    if (!fs.statSync(artifact.source).isFile())
      throw new Error("Android APK output is not a file");
  const tests =
    androidTest && androidTestOutput !== null
      ? variants.map((variant) => ({
          source: path.join(
            outputs,
            "apk/androidTest",
            variant,
            "debug",
            `app-${variant}-debug-androidTest.apk`,
          ),
          target: path.join(
            outputDirectory,
            androidTestOutput,
            `${variant}-androidTest.apk`,
          ),
        }))
      : [];
  for (const test of tests)
    if (!fs.statSync(test.source).isFile())
      throw new Error("Android test APK output is not a file");
  fs.mkdirSync(outputDirectory, { recursive: true });
  // From the first replaced artifact on, the previous record no longer describes
  // what is beside it: withdraw it so an interrupted copy leaves no record at all.
  if (recordText !== null)
    fs.rmSync(path.join(outputDirectory, record.name), { force: true });
  const copy = (source, target) => {
    fs.rmSync(target, { force: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  };
  for (const { name, source, variant, mode } of artifacts) {
    if (mode === "release")
      // Exactly one release name per variant: drop the other form from older builds.
      fs.rmSync(
        path.join(
          outputDirectory,
          `${variant}-release${name.endsWith("-unsigned.apk") ? "" : "-unsigned"}.apk`,
        ),
        { force: true },
      );
    copy(source, path.join(outputDirectory, name));
  }
  for (const { source, target } of tests) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copy(source, target);
  }
  if (mappings)
    for (const variant of variants) {
      const mapping = path.join(
        outputs,
        "mapping",
        `${variant}Release`,
        "mapping.txt",
      );
      if (!fs.existsSync(mapping)) continue;
      fs.mkdirSync(path.join(outputDirectory, "mapping"), { recursive: true });
      copy(
        mapping,
        path.join(outputDirectory, "mapping", `${variant}-release-mapping.txt`),
      );
    }
  if (recordText !== null) {
    // Every artifact of this build is in place: only now does the record describe them.
    const target = path.join(outputDirectory, record.name);
    const pending = path.join(outputDirectory, `.${record.name}.pending`);
    fs.writeFileSync(pending, `${recordText}\n`);
    fs.renameSync(pending, target);
  }
  // Verification must produce a manifest for this invocation, not reuse an old success.
  fs.rmSync(manifest, { force: true });
  invoke(verify);
  if (!fs.statSync(manifest).isFile())
    throw new Error("Android verification manifest is missing");
  const files = artifacts.map(({ name }) => path.join(outputDirectory, name));
  if (metadata === null) return { files, archive: null };
  const destination = path.join(outputDirectory, archive.name);
  const staging = fs.mkdtempSync(
    path.join(outputDirectory, ".android-archive-"),
  );
  const replacement = path.join(staging, "next");
  const previous = path.join(staging, "previous");
  let cleanup = true;
  try {
    fs.mkdirSync(replacement);
    for (const { name } of artifacts)
      fs.copyFileSync(
        path.join(outputDirectory, name),
        path.join(replacement, name),
      );
    fs.copyFileSync(manifest, path.join(replacement, "apk-manifest.json"));
    if (recordText !== null)
      fs.writeFileSync(path.join(replacement, record.name), `${recordText}\n`);
    fs.writeFileSync(path.join(replacement, "service-mode.json"), metadata);
    fs.writeFileSync(
      path.join(replacement, "build-checks.json"),
      JSON.stringify({ lint, androidTest }, null, 2),
    );
    let moved = false;
    try {
      fs.renameSync(destination, previous);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      fs.renameSync(replacement, destination);
    } catch (error) {
      if (moved) {
        // Retain the old archive for recovery if restoring its name also fails.
        cleanup = false;
        fs.renameSync(previous, destination);
        cleanup = true;
      }
      throw error;
    }
  } finally {
    if (cleanup) fs.rmSync(staging, { recursive: true, force: true });
  }
  return { files, archive: destination };
}

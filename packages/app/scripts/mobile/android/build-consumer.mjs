import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Build selected distributions and archive only their verified artifacts.
 * Product hosts select identity, environment, admission commands and archive metadata.
 * Commands use argv without a shell. This does not sign, install or publish APKs. */
export function buildAndroidConsumer({
  root = process.cwd(),
  environment = process.env,
  variants,
  prepare = [],
  verify,
  archive,
  daemon = false,
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
  if (!archive || !/^[a-z][a-z0-9-]*$/.test(archive.name))
    throw new Error("Invalid Android archive name");
  const commands = [...prepare, verify];
  if (
    commands.some(
      (command) =>
        !command ||
        typeof command.command !== "string" ||
        !command.command ||
        !Array.isArray(command.args) ||
        command.args.some((arg) => typeof arg !== "string"),
    )
  ) {
    throw new Error("Invalid Android admission command");
  }
  // Validate metadata before building or replacing any artifact.
  const metadata = JSON.stringify(archive.metadata, null, 2);
  if (metadata === undefined)
    throw new Error("Android archive metadata is required");
  root = path.resolve(root);
  const invoke = ({ command, args }, cwd = root) =>
    run(command, args, { cwd, env: environment, stdio: "inherit" });
  for (const command of prepare) invoke(command);
  const capitalized = variants.map(
    (name) => name[0].toUpperCase() + name.slice(1),
  );
  invoke(
    {
      command: "./gradlew",
      args: [
        daemon ? "--daemon" : "--no-daemon",
        ...["Debug", "Release", "DebugAndroidTest"].flatMap((mode) =>
          capitalized.map((name) => `:app:assemble${name}${mode}`),
        ),
        ":app:lint",
      ],
    },
    path.join(root, "android"),
  );
  const artifacts = variants.flatMap((variant) =>
    ["debug", "release"].map((mode) => {
      const name = `${variant}-${mode}${mode === "release" ? "-unsigned" : ""}.apk`;
      return {
        name,
        source: path.join(
          root,
          "android/app/build/outputs/apk",
          variant,
          mode,
          `app-${name}`,
        ),
      };
    }),
  );
  // A missing variant cannot leave a mixed set copied from this build and a prior run.
  for (const artifact of artifacts)
    if (!fs.statSync(artifact.source).isFile())
      throw new Error("Android APK output is not a file");
  const output = path.join(root, "artifacts");
  fs.mkdirSync(output, { recursive: true });
  for (const { name, source } of artifacts)
    fs.copyFileSync(source, path.join(output, name));
  const manifest = path.join(output, "apk-manifest.json");
  // Verification must produce a manifest for this invocation, not reuse an old success.
  fs.rmSync(manifest, { force: true });
  invoke(verify);
  if (!fs.statSync(manifest).isFile())
    throw new Error("Android verification manifest is missing");
  const destination = path.join(output, archive.name);
  const staging = fs.mkdtempSync(path.join(output, ".android-archive-"));
  const replacement = path.join(staging, "next");
  const previous = path.join(staging, "previous");
  let cleanup = true;
  try {
    fs.mkdirSync(replacement);
    for (const { name } of artifacts)
      fs.copyFileSync(path.join(output, name), path.join(replacement, name));
    fs.copyFileSync(manifest, path.join(replacement, "apk-manifest.json"));
    fs.writeFileSync(path.join(replacement, "service-mode.json"), metadata);
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
  return {
    files: artifacts.map(({ name }) => path.join(output, name)),
    archive: destination,
  };
}

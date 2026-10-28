import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !path.isAbsolute(value) &&
  value.split("/").every((p) => p && p !== "." && p !== "..");
function within(root, name) {
  if (!safe(name)) throw Error(`Unsafe source path: ${name}`);
  return path.join(root, name);
}
async function gitBytes(root, args) {
  return (
    await exec("git", ["-C", root, ...args], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
  ).stdout;
}
async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function checkFile(root, entry) {
  const file = within(root, entry.path),
    stat = fs.lstatSync(file);
  if ("link" in entry) {
    if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.link)
      throw Error(`Source link differs: ${entry.path}`);
    const relative = path.relative(root, fs.realpathSync(file));
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error(`Source link escapes tree: ${entry.path}`);
  } else {
    if (
      !stat.isFile() ||
      stat.size !== entry.sizeBytes ||
      (await fileHash(file)) !== entry.sha256
    )
      throw Error(`Source bytes differ: ${entry.path}`);
  }
}
function inventory(root, relative) {
  const found = [];
  for (const entry of fs.readdirSync(within(root, relative), {
    withFileTypes: true,
  })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...inventory(root, name));
    else found.push(name);
  }
  return found.sort();
}
async function git(root, args) {
  return (
    await exec("git", ["-C", root, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
  ).stdout;
}
/** Verify the recorded source inputs. Does not modify source, admit an APK,
 * certify build outputs, or authorize a flash. Ignored build outputs are not inputs.
 * `developmentOnly` is reported from the lock; production staging separately requires it
 * to be false in the consuming product admission.
 * `appliedPatches` admits a build copy that also carries reviewed manifest-listed source
 * patches supplied by the caller: only their listed files may
 * differ, each preimage at the pinned revision and each postimage must match exactly, and the
 * baseline everywhere else is verified as usual. The caller authenticates the
 * patch file and manifest; this verifier checks the bound source preimages,
 * postimages, baseline and disjoint inventory. */
export async function verifyDeviceSource({
  source,
  factory,
  lock,
  expected,
  appliedPatches = [],
}) {
  if (!source || !factory || !lock)
    throw Error(
      "Device source verification requires a source tree, factory archive and inventory lock",
    );
  if (
    !expected ||
    ["target", "codename", "androidRelease"].some(
      (key) => typeof expected[key] !== "string" || !expected[key],
    )
  )
    throw Error("Expected source target identity is required");
  const root = fs.realpathSync(source),
    bytes = fs.readFileSync(lock),
    contract = JSON.parse(bytes);
  if (
    contract.schema !== 1 ||
    contract.target !== expected.target ||
    contract.device?.codename !== expected.codename ||
    contract.device?.androidRelease !== expected.androidRelease ||
    typeof contract.developmentOnly !== "boolean" ||
    contract.releaseQualified !== false
  )
    throw Error(
      `Not the ${expected.target}/${expected.codename} Android ${expected.androidRelease} source contract`,
    );
  if (!contract.projects?.length || !contract.generated?.files?.length)
    throw Error("Incomplete device source inventory");
  const expectedFactory = contract.factory;
  if (
    !fs.statSync(factory).isFile() ||
    fs.statSync(factory).size !== expectedFactory.sizeBytes ||
    (await fileHash(factory)) !== expectedFactory.sha256
  )
    throw Error("Device factory archive differs from the source lock");
  const manifestRoot = path.join(root, ".repo/manifests");
  if (
    (await git(manifestRoot, ["rev-parse", "HEAD"])).trim() !==
    contract.manifest.commit
  )
    throw Error("AOSP manifest revision differs");
  if (
    (await git(manifestRoot, ["ls-files", "-v", "-z"]))
      .split("\0")
      .some((row) => row && row[0] !== "H") ||
    (
      await git(manifestRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).length
  )
    throw Error("AOSP manifest working tree differs");
  const configuration = contract.manifest.configuration;
  if (
    !Array.isArray(configuration) ||
    !configuration.some((entry) => entry.path === ".repo/manifest.xml") ||
    !configuration.some((entry) => entry.path === ".repo/project.list")
  )
    throw Error("Missing manifest configuration inventory");
  for (const entry of configuration) await checkFile(root, entry);
  const localRoot = ".repo/local_manifests";
  const actualLocal = fs.existsSync(path.join(root, localRoot))
    ? inventory(root, localRoot)
    : [];
  const expectedLocal = configuration
    .filter((entry) => entry.path.startsWith(`${localRoot}/`))
    .map((entry) => entry.path)
    .sort();
  if (JSON.stringify(actualLocal) !== JSON.stringify(expectedLocal))
    throw Error("Local manifest inventory differs");
  const overrides = new Map();
  for (const entry of contract.overrides) {
    if (overrides.has(entry.path))
      throw Error(`Duplicate override: ${entry.path}`);
    overrides.set(entry.path, entry);
  }
  // Patch files are checked by preimage at the pinned revision and exact postimage, not as overrides.
  const patched = new Map();
  for (const { name, manifest } of appliedPatches) {
    if (manifest.baselineLockSha256 !== digest(bytes))
      throw Error(
        `Applied patch ${name} is not reviewed against this source lock`,
      );
    const project = contract.projects.find(
      (entry) => entry.path === manifest.project,
    );
    if (!project || project.commit !== manifest.revision)
      throw Error(
        `Applied patch ${name} does not target a locked project revision`,
      );
    for (const file of manifest.files) {
      const relative = `${manifest.project}/${file.path}`;
      within(root, relative);
      if (overrides.has(relative) || patched.has(relative))
        throw Error(
          `Applied patch overlaps another source change: ${relative}`,
        );
      patched.set(relative, {
        path: file.path,
        beforeSha256: file.beforeSha256,
        afterSha256: file.afterSha256,
      });
    }
  }
  const seen = new Set();
  // Bound filesystem pressure on a full AOSP checkout.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < contract.projects.length) {
        const project = contract.projects[cursor++];
        if (seen.has(project.path))
          throw Error(`Duplicate project: ${project.path}`);
        seen.add(project.path);
        const directory = within(root, project.path);
        if (
          (await git(directory, ["rev-parse", "HEAD"])).trim() !==
          project.commit
        )
          throw Error(`Source revision differs: ${project.path}`);
        const flags = await git(directory, ["ls-files", "-v", "-z"]);
        if (flags.split("\0").some((row) => row && row[0] !== "H"))
          throw Error(`Hidden or unresolved index entries: ${project.path}`);
        const changed = await git(directory, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        const actual = changed
          .split("\0")
          .filter(Boolean)
          .map((row) => `${project.path}/${row.slice(3)}`)
          .sort();
        const expected = [...overrides.keys(), ...patched.keys()]
          .filter((name) => name.startsWith(`${project.path}/`))
          .sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          throw Error(`Unrecorded source changes: ${project.path}`);
        for (const name of expected) {
          if (overrides.has(name)) {
            await checkFile(root, overrides.get(name));
            continue;
          }
          const entry = patched.get(name);
          let before = null;
          try {
            before = digest(
              await gitBytes(directory, ["show", `HEAD:${entry.path}`]),
            );
          } catch {
            before = null;
          }
          if (before !== entry.beforeSha256)
            throw Error(`Applied patch preimage differs: ${name}`);
          const file = within(root, name);
          if (
            !fs.lstatSync(file).isFile() ||
            (await fileHash(file)) !== entry.afterSha256
          )
            throw Error(`Applied patch bytes differ: ${name}`);
        }
        // git status hides ignored source. Bind even ignored extraction-tool outputs;
        // a new ignored Android.bp or source file must not silently enter the build.
        const ignored = (
          await git(directory, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean)
          .map((name) => `${project.path}/${name}`)
          .sort();
        const expectedIgnored = (contract.ignoredInputs ?? []).find(
          (entry) => entry.project === project.path,
        );
        if (ignored.length !== (expectedIgnored?.files ?? 0))
          throw Error(`Ignored source inventory differs: ${project.path}`);
        if (ignored.length) {
          const tree = createHash("sha256");
          for (const name of ignored) {
            const file = within(root, name),
              stat = fs.lstatSync(file);
            const record = stat.isSymbolicLink()
              ? { path: name, link: fs.readlinkSync(file) }
              : {
                  path: name,
                  sizeBytes: stat.size,
                  sha256: await fileHash(file),
                };
            if (!stat.isSymbolicLink() && !stat.isFile())
              throw Error(`Invalid ignored source input: ${name}`);
            tree.update(`${JSON.stringify(record)}\n`);
          }
          if (tree.digest("hex") !== expectedIgnored.sha256)
            throw Error(`Ignored source bytes differ: ${project.path}`);
        }
      }
    }),
  );
  const files = contract.generated.files;
  const expectedNames = files.map((entry) => entry.path).sort();
  if (
    new Set(expectedNames).size !== files.length ||
    files.some((entry) => !entry.path.startsWith(`${contract.generated.root}/`))
  )
    throw Error("Invalid generated vendor inventory");
  if (
    JSON.stringify(inventory(root, contract.generated.root)) !==
    JSON.stringify(expectedNames)
  )
    throw Error("Generated vendor inventory differs");
  for (const entry of files) await checkFile(root, entry);
  return {
    schema: 1,
    target: contract.target,
    codename: contract.device.codename,
    sourceLockSha256: digest(bytes),
    manifestCommit: contract.manifest.commit,
    factorySha256: expectedFactory.sha256,
    projectsChecked: seen.size,
    overridesChecked: overrides.size,
    generatedFilesChecked: files.length,
    developmentOnly: contract.developmentOnly,
    ...(appliedPatches.length
      ? {
          appliedPatches: appliedPatches.map(
            ({ name, manifest, manifestSha256 }) => ({
              name,
              project: manifest.project,
              revision: manifest.revision,
              manifestSha256,
              patchSha256: manifest.patchSha256,
              filesChecked: manifest.files.length,
            }),
          ),
        }
      : {}),
    imageBuilt: false,
    releaseQualified: false,
    deviceAcceptanceVerified: false,
  };
}

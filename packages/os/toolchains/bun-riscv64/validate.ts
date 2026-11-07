import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";

const toolchainRoot = import.meta.dirname;

export function validatePatchInputs(
  directory = toolchainRoot,
  checkArtifact = false,
) {
  const pins = JSON.parse(
    fs.readFileSync(path.join(directory, "bun-version.json"), "utf8"),
  );
  for (const commit of [pins.bun?.commit, pins.webkit?.commit]) {
    if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error("Invalid source commit");
  }
  if (pins.webkit.fork !== "oven-sh/WebKit")
    throw new Error("Unexpected WebKit repository");
  const inputs = [
    "bun-version.json",
    "build.sh",
    "run-build.sh",
    "Dockerfile",
    "validate.ts",
  ];
  for (const kind of ["bun", "webkit"]) {
    const recorded = pins.patches?.[kind];
    if (!recorded || typeof recorded !== "object" || Array.isArray(recorded))
      throw new Error(`Missing ${kind} patch inventory`);
    const names = Object.keys(recorded).sort();
    const patchDirectory = path.join(directory, `${kind}-patches`);
    const actual = fs
      .readdirSync(patchDirectory)
      .filter((name) => name.endsWith(".patch"))
      .sort();
    if (!names.length || JSON.stringify(names) !== JSON.stringify(actual))
      throw new Error(`${kind} patch inventory differs from disk`);
    for (const name of names) {
      if (
        !/^\d{4}-[a-z0-9-]+\.patch$/.test(name) ||
        !/^[a-f0-9]{64}$/.test(recorded[name])
      )
        throw new Error(`Invalid patch identity: ${name}`);
      const relative = `${kind}-patches/${name}`;
      const digest = createHash("sha256")
        .update(fs.readFileSync(path.join(directory, relative)))
        .digest("hex");
      if (digest !== recorded[name])
        throw new Error(`Patch digest mismatch: ${relative}`);
      inputs.push(relative);
    }
  }
  if (
    typeof pins.artifact?.filename !== "string" ||
    path.basename(pins.artifact.filename) !== pins.artifact.filename
  )
    throw new Error("Invalid artifact filename");
  const artifact = path.join(directory, "dist", pins.artifact.filename);
  if (checkArtifact && fs.existsSync(artifact)) {
    const builtAt = fs.statSync(artifact).mtimeMs;
    const changed = inputs.find(
      (input) => fs.statSync(path.join(directory, input)).mtimeMs > builtAt,
    );
    if (changed) throw new Error(`Artifact predates build input: ${changed}`);
  }
  return pins;
}

function validateStacks(pins, directory) {
  const report = testOutputPath("os-riscv-patches", "validation.log");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const log = fs.openSync(report, "w");
  try {
    for (const kind of ["bun", "webkit"]) {
      const commit = pins[kind].commit;
      const repository = kind === "bun" ? "oven-sh/bun" : pins.webkit.fork;
      const cache = testOutputPath("os-riscv-patches", "sources", kind);
      fs.mkdirSync(cache, { recursive: true });
      const git = (args: string[], env = process.env) =>
        execFileSync("git", ["-C", cache, ...args], {
          env,
          stdio: ["ignore", log, log],
        });
      if (!fs.existsSync(path.join(cache, "HEAD"))) git(["init", "--bare"]);
      git([
        "config",
        "remote.origin.url",
        `https://github.com/${repository}.git`,
      ]);
      git(["config", "remote.origin.promisor", "true"]);
      git(["config", "remote.origin.partialclonefilter", "blob:none"]);
      fs.writeSync(log, `SOURCE ${repository}@${commit}\n`);
      try {
        git(["cat-file", "-e", `${commit}^{commit}`], {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
        });
      } catch {
        git(["fetch", "--depth=1", "--filter=blob:none", "origin", commit]);
      }
      const index = path.join(cache, `${randomUUID()}.index`);
      const env = { ...process.env, GIT_INDEX_FILE: index };
      try {
        git(["read-tree", commit], env);
        for (const name of Object.keys(pins.patches[kind]).sort()) {
          const patch = path.join(directory, `${kind}-patches`, name);
          git(["apply", "--cached", "--check", patch], env);
          git(["apply", "--cached", patch], env);
          fs.writeSync(log, `PASS ${kind}/${name}\n`);
        }
      } finally {
        fs.rmSync(index, { force: true });
        fs.rmSync(`${index}.lock`, { force: true });
      }
    }
  } catch (error) {
    throw new Error(`Patch application failed; see ${report}`, {
      cause: error,
    });
  } finally {
    fs.closeSync(log);
  }
  console.log(
    `Patch integrity and stack application passed. Report: ${report}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--integrity-only"))
    throw new Error("Usage: validate.ts [--integrity-only]");
  const pins = validatePatchInputs(toolchainRoot, args.length === 0);
  if (args.length)
    console.log(
      "Patch integrity passed; source application and runtime behavior are unverified.",
    );
  else validateStacks(pins, toolchainRoot);
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConsumerSourceError } from "./committed-source.mjs";

/** @param {Buffer} bytes */
const blobHash = (bytes) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
/** Authenticate a prepared workspace, including ignored files and Git stat bypasses.
 * Build output allowances are host configuration, never source-patch overrides.
 * @param {string} directory
 * @param {string} commit
 * @param {{generatedFiles?: string[], generatedDirectories?: string[]}} [options]
 */
export function verifyCommittedWorkspace(
  directory,
  commit,
  { generatedFiles = [], generatedDirectories = [] } = {},
) {
  try {
    if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
      throw new ConsumerSourceError("Exact admitted runtime commit required");
    for (const value of [...generatedFiles, ...generatedDirectories]) {
      if (
        typeof value !== "string" ||
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) ||
        value.split("/").some((part) => part === "." || part === "..")
      )
        throw new ConsumerSourceError(
          "Generated paths must be explicit workspace-relative paths",
        );
    }
    /** @param {string[]} args */
    const git = (args) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    if (
      fs.realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !==
      fs.realpathSync(directory)
    )
      throw new ConsumerSourceError("Source must be the Git checkout root");
    if (git(["rev-parse", "HEAD"]).trim() !== commit)
      throw new ConsumerSourceError("Prepared runtime base commit changed");
    // Authenticate every committed file, including ignored tracked files.
    const entries = git(["ls-tree", "-r", "-z", "HEAD"])
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const [meta, file] = entry.split("\t");
      const [mode, type, oid] = meta.split(" ");
      if (type === "commit") continue;
      const absolute = path.join(directory, file);
      if (mode === "120000") {
        if (
          !fs.existsSync(absolute) ||
          !fs.lstatSync(absolute).isSymbolicLink() ||
          blobHash(Buffer.from(fs.readlinkSync(absolute))) !== oid
        )
          throw new ConsumerSourceError(
            `Unsupported baseline symlink: ${file}`,
          );
        continue;
      }
      if (
        !fs.existsSync(absolute) ||
        fs.lstatSync(absolute).isSymbolicLink() ||
        (fs.statSync(absolute).mode & 0o111) !==
          (mode === "100755" ? 0o111 : 0) ||
        blobHash(fs.readFileSync(absolute)) !== oid
      )
        throw new ConsumerSourceError(
          `Unexpected runtime source change: ${file}`,
        );
    }
    for (const file of git(["diff", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean))
      throw new ConsumerSourceError(
        `Unexpected runtime source change: ${file}`,
      );
    const packageFiles = new Set(entries.map((entry) => entry.split("\t")[1]));
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    const turbo = JSON.parse(
      fs.readFileSync(path.join(directory, "turbo.json"), "utf8"),
    );
    /** @type {string[]} */
    const workspacePatterns = Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : rootPackage.workspaces.packages;
    const workspaceRoots = [...packageFiles]
      .filter((file) => file.endsWith("/package.json"))
      .map((file) => file.slice(0, -"/package.json".length))
      .filter((dir) =>
        workspacePatterns.some((pattern) => path.matchesGlob(dir, pattern)),
      );
    const generatedRoots = [
      "node_modules/",
      ".turbo/cache/",
      ...generatedDirectories.map((value) => `${value}/`),
    ];
    const generatedLogs = new Set();
    for (const workspace of workspaceRoots) {
      generatedRoots.push(`${workspace}/node_modules/`);
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(directory, workspace, "package.json"),
          "utf8",
        ),
      );
      for (const [task, definition] of Object.entries(turbo.tasks)) {
        if (task.includes("#") && !task.startsWith(`${pkg.name}#`)) continue;
        for (const output of definition.outputs || []) {
          // Only literal, workspace-relative directory declarations; never wildcard ancestors.
          if (
            !/^(?:[a-zA-Z0-9_.-]+\/)+\*\*$/.test(output) ||
            output.split("/").includes("..")
          )
            continue;
          generatedRoots.push(`${workspace}/${output.slice(0, -2)}`);
        }
        const name = task.includes("#") ? task.split("#")[1] : task;
        if (/^[a-zA-Z0-9:_-]+$/.test(name))
          generatedLogs.add(
            workspace +
              "/.turbo/turbo-" +
              name.replaceAll(":", "$colon$") +
              ".log",
          );
      }
    }
    /** @param {string} file */
    const allowedGenerated = (file) =>
      generatedFiles.includes(file) ||
      generatedLogs.has(file) ||
      generatedRoots.some((prefix) => file.startsWith(prefix));
    // Include ignored files: .gitignore must not hide unexpected source additions.
    for (const file of git(["ls-files", "--others", "-z"])
      .split("\0")
      .filter(Boolean))
      if (!allowedGenerated(file))
        throw new ConsumerSourceError(
          `Unexpected untracked runtime source: ${file}`,
        );
  } catch (cause) {
    if (cause instanceof ConsumerSourceError) throw cause;
    throw new ConsumerSourceError("Cannot authenticate prepared workspace", {
      cause,
    });
  }
}

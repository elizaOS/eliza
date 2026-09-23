/**
 * Preserves installed and cached Vitest bytes around Windows native probes.
 * Each phase is immutable and records file hashes and link metadata without
 * following nested links or changing the installation under investigation.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [phase, destination, cacheRoot, ...extra] = process.argv.slice(2);
if (
  !/^[a-z-]+$/.test(phase ?? "") ||
  !destination ||
  !cacheRoot ||
  extra.length
) {
  throw new Error(
    "Usage: capture-vitest-install.mjs <phase> <destination> <bun-cache>",
  );
}
const root = process.cwd();
const output = path.resolve(destination, phase);
fs.mkdirSync(output, { recursive: false });
const manifest = {
  phase,
  sourceSha: process.env.GITHUB_SHA ?? null,
  runtime: process.version,
  platform: process.platform,
  capturedAt: new Date().toISOString(),
  resolution: null,
  roots: [],
};

function statOrMissing(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    // error-policy:J4 Missing package files are the diagnostic result.
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function inspect(file) {
  const stat = statOrMissing(file);
  if (!stat) return { path: file, state: "missing" };
  const record = {
    path: file,
    state: "present",
    kind: stat.isSymbolicLink()
      ? "link"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other",
    size: stat.size,
    inode: stat.ino,
    device: stat.dev,
    links: stat.nlink,
    mode: stat.mode,
    modifiedAt: stat.mtime.toISOString(),
  };
  if (stat.isSymbolicLink()) record.linkTarget = fs.readlinkSync(file);
  try {
    record.realPath = fs.realpathSync(file);
  } catch (error) {
    // error-policy:J4 Broken reparse/link targets remain visible in evidence.
    if (error.code !== "ENOENT") throw error;
    record.targetState = "missing";
  }
  return record;
}

function capture(label, source) {
  const entry = { label, source: inspect(source), files: [], cliChunks: [] };
  manifest.roots.push(entry);
  if (!entry.source.realPath) return;
  const actualRoot = entry.source.realPath;
  const bytesRoot = path.join(output, label);
  function visit(relative) {
    const file = path.join(actualRoot, relative);
    const record = inspect(file);
    record.relativePath = relative;
    entry.files.push(record);
    if (record.kind === "directory") {
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(relative, name));
    } else if (record.kind === "file") {
      const bytes = fs.readFileSync(file);
      record.sha256 = createHash("sha256").update(bytes).digest("hex");
      const target = path.join(bytesRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
    }
  }
  visit("");
  const cli = path.join(actualRoot, "dist", "cli.js");
  if (statOrMissing(cli)?.isFile()) {
    for (const match of fs
      .readFileSync(cli, "utf8")
      .matchAll(/['"](\.\/chunks\/[^'"]+)['"]/g)) {
      entry.cliChunks.push(inspect(path.resolve(path.dirname(cli), match[1])));
    }
  }
}

const consumer = path.join(
  root,
  "packages/app-core/platforms/electrobun/package.json",
);
try {
  const packageJson = createRequire(consumer).resolve("vitest/package.json");
  manifest.resolution = {
    packageJson,
    version: JSON.parse(fs.readFileSync(packageJson, "utf8")).version,
  };
  capture("resolved-installed", path.dirname(packageJson));
} catch (error) {
  // error-policy:J4 Failed module resolution is preserved rather than repaired.
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  manifest.resolution = { error: error.code, message: error.message };
}
capture("root-link", path.join(root, "node_modules/vitest"));
capture(
  "consumer-link",
  path.join(path.dirname(consumer), "node_modules/vitest"),
);
for (const [label, directory] of [
  ["installed", path.join(root, "node_modules/.bun")],
  ["cache", path.resolve(cacheRoot)],
]) {
  const directoryState = inspect(directory);
  manifest.roots.push({ label: `${label}-directory`, source: directoryState });
  if (directoryState.state !== "present") continue;
  for (const name of fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("vitest@"))
    .sort()) {
    capture(`${label}-${manifest.roots.length}`, path.join(directory, name));
  }
}
fs.writeFileSync(
  path.join(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    phase,
    output,
    roots: manifest.roots.length,
    resolution: manifest.resolution,
  }),
);

#!/usr/bin/env node
/**
 * Materializes only bounded documentation blobs from an untrusted PR onto its
 * trusted base checkout, then validates AI-produced edits before they cross
 * into the write-authorized documentation PR job.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_DOC_FILES = 200;
export const MAX_MODEL_INPUT_FILES = 512;
export const MAX_DOC_FILE_BYTES = 512 * 1024;
export const MAX_DOC_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_DOC_PATCH_BYTES = 4 * 1024 * 1024;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const DOC_PATH_RE =
  /^packages\/docs\/(?:[A-Za-z0-9_.-]+\/)*(?:[A-Za-z0-9_.-]+\.mdx?|docs\.json|mint\.json)$/;

export function isAllowedDocsPath(path) {
  return (
    DOC_PATH_RE.test(path) &&
    !path.includes("//") &&
    !path.split("/").includes("..")
  );
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: options.encoding ?? "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function nulPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function assertBoundedPaths(paths) {
  const unique = [...new Set(paths)].sort();
  if (unique.length > MAX_DOC_FILES) {
    throw new RangeError(
      `[DocsCiBoundary] ${unique.length} documentation files exceed the ${MAX_DOC_FILES}-file limit`,
    );
  }
  for (const path of unique) {
    if (!isAllowedDocsPath(path)) {
      throw new TypeError(
        `[DocsCiBoundary] untrusted documentation path is not allowed: ${JSON.stringify(path)}`,
      );
    }
  }
  return unique;
}

function trustedDocumentationPaths(cwd) {
  const paths = nulPaths(
    git(["ls-files", "-z", "--", "packages/docs"], {
      cwd,
      encoding: "buffer",
    }),
  ).filter(isAllowedDocsPath);
  const unique = [...new Set(paths)].sort();
  if (unique.length > MAX_MODEL_INPUT_FILES) {
    throw new RangeError(
      `[DocsCiBoundary] ${unique.length} trusted documentation files exceed the ${MAX_MODEL_INPUT_FILES}-file model-input limit`,
    );
  }
  return unique;
}

function treeBlob(revision, path, cwd) {
  const listing = git(["ls-tree", "-z", revision, "--", path], {
    cwd,
    encoding: "buffer",
  });
  if (listing.length === 0) return null;
  const records = nulPaths(listing);
  if (records.length !== 1) {
    throw new TypeError(
      `[DocsCiBoundary] expected one tree record for ${path}`,
    );
  }
  const [metadata, listedPath] = records[0].split("\t");
  const [mode, type, object] = metadata.split(" ");
  if (
    listedPath !== path ||
    mode !== "100644" ||
    type !== "blob" ||
    !FULL_SHA_RE.test(object)
  ) {
    throw new TypeError(
      `[DocsCiBoundary] ${path} must be one non-executable regular blob`,
    );
  }
  const size = Number(git(["cat-file", "-s", object], { cwd }).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOC_FILE_BYTES) {
    throw new RangeError(
      `[DocsCiBoundary] ${path} exceeds the ${MAX_DOC_FILE_BYTES}-byte file limit`,
    );
  }
  return { object, size };
}

function manifestDestination(environment) {
  const runnerTemp = environment.RUNNER_TEMP;
  if (!runnerTemp) {
    throw new TypeError("[DocsCiBoundary] RUNNER_TEMP is required");
  }
  return resolve(runnerTemp, "docs-ci-boundary.json");
}

function writeStepOutput(name, value, environment) {
  const outputPath = environment.GITHUB_OUTPUT;
  if (outputPath) {
    writeFileSync(outputPath, `${name}=${value}\n`, { flag: "a" });
  }
}

export function materializePullRequest(
  eventPath,
  { cwd = process.cwd(), environment = process.env } = {},
) {
  const resolvedEventPath = eventPath ?? environment.GITHUB_EVENT_PATH;
  if (!resolvedEventPath) {
    throw new TypeError("[DocsCiBoundary] GITHUB_EVENT_PATH is required");
  }
  const event = JSON.parse(readFileSync(resolvedEventPath, "utf8"));
  const destination = manifestDestination(environment);
  if (!event.pull_request) {
    const readPaths = trustedDocumentationPaths(cwd);
    const manifest = {
      mode: "trusted-dispatch",
      base: git(["rev-parse", "HEAD"], { cwd }).trim(),
      head: null,
      paths: null,
      readPaths,
    };
    writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    writeStepOutput("manifest", destination, environment);
    writeStepOutput("paths_json", JSON.stringify(readPaths), environment);
    return manifest;
  }

  const base = event.pull_request.base?.sha;
  const head = event.pull_request.head?.sha;
  const baseRepository = event.pull_request.base?.repo?.full_name;
  const expectedRepository = environment.GITHUB_REPOSITORY;
  if (
    !FULL_SHA_RE.test(base) ||
    !FULL_SHA_RE.test(head) ||
    !expectedRepository ||
    baseRepository !== expectedRepository
  ) {
    throw new TypeError(
      "[DocsCiBoundary] event omitted an exact same-repository base or PR head SHA",
    );
  }
  if (git(["rev-parse", "HEAD"], { cwd }).trim() !== base) {
    throw new Error(
      "[DocsCiBoundary] workspace must be checked out at the trusted PR base SHA",
    );
  }

  git(
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "origin",
      head,
    ],
    { cwd, stdio: "ignore" },
  );
  if (git(["rev-parse", "FETCH_HEAD"], { cwd }).trim() !== head) {
    throw new Error(
      "[DocsCiBoundary] fetched PR head does not match the event",
    );
  }
  // packages/docs legitimately carries non-page files (package.json, brand
  // images, logos). Only .md/.mdx/docs.json/mint.json cross into the model
  // job; everything else is ignored on this input side rather than failing
  // the PR — the strict allowlist stays on the model-output/patch side.
  const changedPaths = nulPaths(
    git(
      [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        `${base}...${head}`,
        "--",
        "packages/docs",
      ],
      { cwd, encoding: "buffer" },
    ),
  );
  const skippedPaths = [
    ...new Set(changedPaths.filter((path) => !isAllowedDocsPath(path))),
  ].sort();
  if (skippedPaths.length > 0) {
    process.stdout.write(
      `::notice::[DocsCiBoundary] ignoring ${skippedPaths.length} non-documentation path(s) under packages/docs: ${skippedPaths.join(", ")}\n`,
    );
  }
  const paths = assertBoundedPaths(changedPaths.filter(isAllowedDocsPath));

  let totalBytes = 0;
  for (const path of paths) {
    const blob = treeBlob(head, path, cwd);
    const absolutePath = resolve(cwd, path);
    if (blob === null) {
      rmSync(absolutePath, { force: true });
      continue;
    }
    totalBytes += blob.size;
    if (totalBytes > MAX_DOC_TOTAL_BYTES) {
      throw new RangeError(
        `[DocsCiBoundary] changed documentation exceeds the ${MAX_DOC_TOTAL_BYTES}-byte total limit`,
      );
    }
    const contents = git(["cat-file", "blob", blob.object], {
      cwd,
      encoding: "buffer",
    });
    if (contents.length !== blob.size) {
      throw new Error(`[DocsCiBoundary] blob size changed for ${path}`);
    }
    rmSync(absolutePath, { force: true, recursive: true });
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, { flag: "wx", mode: 0o644 });
  }

  const manifest = {
    mode: "untrusted-pr",
    base,
    head,
    paths,
    readPaths: paths,
  };
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  writeStepOutput("manifest", destination, environment);
  writeStepOutput("paths_json", JSON.stringify(paths), environment);
  return manifest;
}

function changedWorkspacePaths(cwd, baseRevision) {
  const paths = [
    ...nulPaths(
      git(["diff", "--name-only", "-z", baseRevision, "--"], {
        cwd,
        encoding: "buffer",
      }),
    ),
    ...nulPaths(
      git(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd,
        encoding: "buffer",
      }),
    ),
  ];
  return [...new Set(paths)].sort();
}

function ignoredDocsPaths(cwd) {
  return nulPaths(
    git(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        "packages/docs",
      ],
      { cwd, encoding: "buffer" },
    ),
  );
}

function readBoundaryManifest(manifestPath) {
  if (!manifestPath) {
    return { mode: "trusted-patch", paths: null };
  }
  const stats = lstatSync(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new TypeError(
      "[DocsCiBoundary] boundary manifest must be a bounded regular file",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("[DocsCiBoundary] boundary manifest must be an object");
  }
  if (manifest.mode === "untrusted-pr") {
    if (
      !FULL_SHA_RE.test(manifest.base) ||
      !FULL_SHA_RE.test(manifest.head) ||
      !Array.isArray(manifest.paths) ||
      !Array.isArray(manifest.readPaths)
    ) {
      throw new TypeError(
        "[DocsCiBoundary] untrusted PR manifest is incomplete",
      );
    }
    const paths = assertBoundedPaths(manifest.paths);
    const readPaths = assertBoundedPaths(manifest.readPaths);
    if (
      paths.length !== readPaths.length ||
      paths.some((path, index) => path !== readPaths[index])
    ) {
      throw new TypeError(
        "[DocsCiBoundary] untrusted PR read paths must equal its reviewed paths",
      );
    }
    return { ...manifest, paths, readPaths };
  }
  if (
    manifest.mode === "trusted-dispatch" &&
    FULL_SHA_RE.test(manifest.base) &&
    manifest.head === null &&
    manifest.paths === null &&
    Array.isArray(manifest.readPaths) &&
    manifest.readPaths.length <= MAX_MODEL_INPUT_FILES &&
    manifest.readPaths.every(isAllowedDocsPath)
  ) {
    return {
      ...manifest,
      readPaths: [...new Set(manifest.readPaths)].sort(),
    };
  }
  throw new TypeError("[DocsCiBoundary] boundary manifest mode is invalid");
}

function resolveBaseRevision(cwd, candidate) {
  const revision = candidate ?? git(["rev-parse", "HEAD"], { cwd }).trim();
  if (
    !FULL_SHA_RE.test(revision) ||
    git(["cat-file", "-t", revision], { cwd }).trim() !== "commit"
  ) {
    throw new TypeError(
      "[DocsCiBoundary] patch base must be an exact commit SHA",
    );
  }
  return revision;
}

export function validateGeneratedChanges(
  manifestPath,
  { cwd = process.cwd(), baseRevision } = {},
) {
  const manifest = readBoundaryManifest(manifestPath);
  const allowed = Array.isArray(manifest.paths)
    ? new Set(manifest.paths)
    : null;
  const base = resolveBaseRevision(cwd, baseRevision);
  const ignored = ignoredDocsPaths(cwd);
  if (ignored.length > 0) {
    throw new TypeError(
      `[DocsCiBoundary] generated ignored documentation cannot cross the patch boundary: ${ignored.join(", ")}`,
    );
  }
  const paths = assertBoundedPaths(changedWorkspacePaths(cwd, base));
  let totalBytes = 0;
  for (const path of paths) {
    if (allowed && !allowed.has(path)) {
      throw new TypeError(
        `[DocsCiBoundary] model changed a path outside the reviewed PR docs: ${path}`,
      );
    }
    const absolutePath = resolve(cwd, path);
    if (!existsSync(absolutePath)) continue;
    const stats = lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new TypeError(
        `[DocsCiBoundary] generated documentation is not a regular file: ${path}`,
      );
    }
    if ((stats.mode & 0o111) !== 0) {
      throw new TypeError(
        `[DocsCiBoundary] generated documentation is executable: ${path}`,
      );
    }
    if (stats.size > MAX_DOC_FILE_BYTES) {
      throw new RangeError(
        `[DocsCiBoundary] generated ${path} exceeds the per-file limit`,
      );
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_DOC_TOTAL_BYTES) {
      throw new RangeError(
        "[DocsCiBoundary] generated documentation exceeds the total limit",
      );
    }
  }
  const summary = git(["diff", "--summary", base, "--"], { cwd });
  if (/(?:mode change|create mode 120000)/i.test(summary)) {
    throw new TypeError(
      "[DocsCiBoundary] generated documentation changes file modes or creates a symlink",
    );
  }
  git(["diff", "--check", base, "--"], { cwd, stdio: "ignore" });
  const patch = git(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      base,
      "--",
      "packages/docs",
    ],
    { cwd, encoding: "buffer" },
  );
  if (patch.length > MAX_DOC_PATCH_BYTES) {
    throw new RangeError(
      `[DocsCiBoundary] generated patch exceeds the ${MAX_DOC_PATCH_BYTES}-byte limit`,
    );
  }
  return { paths, totalBytes, patchBytes: patch.length };
}

function main() {
  const [mode, manifestPath, baseRevision] = process.argv.slice(2);
  if (mode === "materialize") {
    const result = materializePullRequest();
    console.log(
      `[DocsCiBoundary] materialized ${result.paths?.length ?? 0} untrusted documentation files`,
    );
    return;
  }
  if (mode === "validate") {
    const result = validateGeneratedChanges(manifestPath, { baseRevision });
    console.log(
      `[DocsCiBoundary] validated ${result.paths.length} documentation files (${result.totalBytes} bytes)`,
    );
    return;
  }
  throw new TypeError(
    "Usage: node scripts/docs-ci-boundary.mjs <materialize|validate> [manifest] [base-sha]",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the workflow utility boundary emits a failed step rather
    // than carrying an unbounded or untrusted patch into a write-capable job.
    console.error(
      error instanceof Error ? error.message : "[DocsCiBoundary] failed",
    );
    process.exitCode = 1;
  }
}

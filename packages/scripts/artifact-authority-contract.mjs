#!/usr/bin/env node
/**
 * Enforces source-owned artifact production at repository bootstrap boundaries.
 * Installs may patch/build workspace dependencies, but they must never overlay
 * the checkout from a global archive or revive prebuilt native/runtime outputs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const RETIRED_FILES = [
  "packages/scripts/artifacts-manifest.json",
  "packages/scripts/sync-artifacts.mjs",
];

const RETIRED_MARKERS = [
  "ELIZA_SKIP_ARTIFACT_SYNC",
  "artifacts-manifest.json",
  "eliza-dev-artifacts.tar.gz",
  "elizaOS/eliza-archive",
  "packages/scripts/sync-artifacts.mjs",
];

const RETIRED_IGNORE_MARKERS = [
  ".eliza-artifacts-version",
  "elizaOS/eliza-archive",
  "packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts/elizaos-app/agent-bundle.js",
  "packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts/elizaos-app/musl-runtime/bun",
  "plugins/plugin-local-inference/native/verify/cuda_verify",
  "synced artifacts (stripped for fast clones",
];

const SHELL_PARAMETER_PREFIX = "$";

const SOURCE_OWNED_CONTRACTS = [
  {
    path: "plugins/plugin-local-inference/native/verify/Makefile",
    fragments: ["cuda_verify: cuda_verify.cu", "-o cuda_verify"],
  },
  {
    path: "plugins/plugin-local-inference/native/.gitignore",
    fragments: ["verify/cuda_verify"],
  },
  {
    path: "packages/app-core/scripts/aosp/compile-libllama.mjs",
    fragments: [
      "plugins/plugin-local-inference/native/llama.cpp",
      "libelizainference.so",
    ],
  },
  {
    path: ".github/workflows/build-llama-ffi-android.yml",
    fragments: [
      "node packages/app-core/scripts/aosp/compile-libllama.mjs",
      "if-no-files-found: error",
    ],
  },
  {
    path: "packages/os/linux/elizaos/scripts/stage-agent-artifacts.sh",
    fragments: [
      "packages/agent/dist-mobile/agent-bundle.js",
      `OUT="${SHELL_PARAMETER_PREFIX}{LINUX_DIR}/artifacts/${SHELL_PARAMETER_PREFIX}{ARCH}"`,
      "missing built agent bundle",
    ],
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function read(repoRoot, relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function activeWorkflowText(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function collectFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ![".git", ".turbo", "dist", "node_modules"].includes(entry.name)
      ) {
        pending.push(resolve(directory, entry.name));
      } else if (entry.isFile()) {
        const path = resolve(directory, entry.name);
        if (predicate(path, entry.name)) files.push(path);
      }
    }
  }
  return files.sort();
}

function assertScriptsDoNotReviveArchive(repoRoot, manifestPath) {
  const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (packageJson.scripts === undefined) return;
  const manifest = relative(repoRoot, manifestPath) || "package.json";
  assert(
    packageJson.scripts !== null &&
      typeof packageJson.scripts === "object" &&
      !Array.isArray(packageJson.scripts),
    `${manifest} scripts must be an object`,
  );
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert(
      typeof command === "string",
      `${manifest} script ${name} must be a string`,
    );
    for (const marker of RETIRED_MARKERS) {
      assert(
        !command.includes(marker),
        `${manifest} script ${name} revives retired global artifact authority via ${marker}`,
      );
    }
  }
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const rootManifest = resolve(repoRoot, "package.json");
  assert(existsSync(rootManifest), "package.json must exist");
  const packageManifests = [
    rootManifest,
    ...["packages", "plugins"].flatMap((directory) =>
      collectFiles(
        resolve(repoRoot, directory),
        (_path, name) => name === "package.json",
      ),
    ),
  ];
  for (const manifestPath of packageManifests) {
    assertScriptsDoNotReviveArchive(repoRoot, manifestPath);
  }

  for (const relativePath of RETIRED_FILES) {
    assert(
      !existsSync(resolve(repoRoot, relativePath)),
      `${relativePath} is retired; artifacts must have an explicit producer and consumer`,
    );
  }

  const gitignore = read(repoRoot, ".gitignore");
  for (const marker of RETIRED_IGNORE_MARKERS) {
    assert(
      !gitignore.includes(marker),
      `.gitignore still hides retired archive state via ${marker}`,
    );
  }

  const automationFiles = collectFiles(
    resolve(repoRoot, ".github"),
    (_path, name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  for (const path of automationFiles) {
    const activeText = activeWorkflowText(readFileSync(path, "utf8"));
    for (const marker of RETIRED_MARKERS) {
      assert(
        !activeText.includes(marker),
        `${relative(repoRoot, path)} revives retired global artifact authority via ${marker}`,
      );
    }
  }

  for (const contract of SOURCE_OWNED_CONTRACTS) {
    const content = read(repoRoot, contract.path);
    for (const fragment of contract.fragments) {
      assert(
        content.includes(fragment),
        `${contract.path} lost source-owned artifact contract fragment ${fragment}`,
      );
    }
  }

  return {
    ok: true,
    contracts: SOURCE_OWNED_CONTRACTS.map(({ path }) => path),
    automationFilesScanned: automationFiles.length,
    packageManifestsScanned: packageManifests.length,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  try {
    const { automationFilesScanned, contracts, packageManifestsScanned } =
      runContract();
    console.log(
      `artifact authority contract passed (${contracts.length} source-owned contract paths; ${automationFilesScanned} automation files and ${packageManifestsScanned} package manifests scanned)`,
    );
  } catch (error) {
    // error-policy:J1 CLI boundary translates a contract violation to a non-zero process result.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[artifact-authority-contract] FAIL ${message}`);
    process.exitCode = 1;
  }
}

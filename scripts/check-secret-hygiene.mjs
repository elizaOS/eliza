import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const repoRoots = discoverTrackedRepos(workspaceRoot);
const trackedBuffers = [];
const violations = [];
let trackedFileCount = 0;
const knownNonSecretValues = new Set([
  "playwright-local-auth-secret",
  "sk-or-e2e-test-token",
  "test-internal-secret",
  "test-cron-secret",
]);

for (const repoRoot of repoRoots) {
  const trackedFiles = listTrackedFiles(repoRoot).filter((trackedFile) =>
    fs.existsSync(path.join(repoRoot, trackedFile)),
  );
  trackedFileCount += trackedFiles.length;

  for (const trackedFile of trackedFiles) {
    if (!isDisallowedTrackedPath(trackedFile)) {
      continue;
    }

    violations.push({
      type: "tracked-secret-file",
      path: toWorkspacePath(repoRoot, trackedFile),
      detail: "Tracked env/vercel state file must stay out of git.",
    });
  }

  trackedBuffers.push(...loadTrackedFileBuffers(repoRoot, trackedFiles));
}

const localSecretEntries = collectLocalSecretEntries(workspaceRoot);
if (localSecretEntries.length > 0) {
  for (const entry of localSecretEntries) {
    for (const trackedFile of trackedBuffers) {
      if (!trackedFile.buffer.includes(entry.buffer)) {
        continue;
      }

      violations.push({
        type: "secret-value-match",
        path: trackedFile.path,
        detail: `${entry.name} from ${entry.source} matches tracked content.`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("[secret-hygiene] FAIL");
  for (const violation of violations) {
    console.error(`- ${violation.path}: ${violation.detail}`);
  }
  process.exit(1);
}

console.log(
  `[secret-hygiene] PASS (${trackedFileCount} tracked files across ${repoRoots.length} repos, ${localSecretEntries.length} local secrets checked)`,
);

function discoverTrackedRepos(rootDir) {
  const repos = [];
  const queue = [rootDir];
  const seen = new Set();
  const ignoredDirs = new Set([
    ".git",
    ".next",
    ".turbo",
    ".vite",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "playwright-report",
    "test-results",
  ]);

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir || seen.has(currentDir)) {
      continue;
    }

    seen.add(currentDir);

    if (fs.existsSync(path.join(currentDir, ".git"))) {
      repos.push(currentDir);
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirs.has(entry.name)) {
        continue;
      }

      queue.push(path.join(currentDir, entry.name));
    }
  }

  return repos.sort((left, right) => left.localeCompare(right));
}

function listTrackedFiles(cwd) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });

  return output
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isDisallowedTrackedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized);

  if (normalized.includes("/.vercel/") || normalized.startsWith(".vercel/")) {
    return true;
  }

  if (/^\.dev\.vars(?:\.|$)/.test(baseName)) {
    return !baseName.endsWith(".example");
  }

  if (/^\.env(?:\.|$)/.test(baseName)) {
    return !baseName.endsWith(".example");
  }

  return false;
}

function collectLocalSecretEntries(rootDir) {
  const entries = [];

  for (const absolutePath of findLocalEnvFiles(rootDir)) {
    for (const parsed of parseEnvFile(absolutePath)) {
      if (!looksLikeSecret(parsed)) {
        continue;
      }

      entries.push({
        ...parsed,
        source: path.relative(rootDir, absolutePath).replaceAll(path.sep, "/"),
        buffer: Buffer.from(parsed.value),
      });
    }
  }

  return dedupeEntries(entries);
}

function findLocalEnvFiles(rootDir) {
  const files = [];
  const queue = [rootDir];
  const ignoredDirs = new Set([
    ".git",
    ".next",
    ".turbo",
    ".vite",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "playwright-report",
    "test-results",
  ]);

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          queue.push(path.join(currentDir, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!isLocalSecretFileName(entry.name)) {
        continue;
      }

      files.push(path.join(currentDir, entry.name));
    }
  }

  return files;
}

function isLocalSecretFileName(fileName) {
  if (fileName.endsWith(".example")) {
    return false;
  }

  return (
    /^\.env(?:\.|$)/.test(fileName) || /^\.dev\.vars(?:\.|$)/.test(fileName)
  );
}

function parseEnvFile(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const parsed = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
    );
    if (!match) {
      continue;
    }

    const [, name, rawValue] = match;
    const value = stripWrappingQuotes(rawValue.trim());
    if (!value) {
      continue;
    }

    parsed.push({ name, value });
  }

  return parsed;
}

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function looksLikeSecret(entry) {
  if (entry.name === "ELIZA_APP_LEADER_KEY") {
    return false;
  }

  if (entry.value.length < 12) {
    return false;
  }

  if (/^(?:true|false|null|undefined)$/i.test(entry.value)) {
    return false;
  }

  if (knownNonSecretValues.has(entry.value)) {
    return false;
  }

  if (
    /^(?:your_|replace_|example|changeme|localhost[:/]|http:\/\/127\.0\.0\.1)/i.test(
      entry.value,
    )
  ) {
    return false;
  }

  if (
    !/(KEY|SECRET|TOKEN|PASSWORD|CLIENT_ID|CLIENT_SECRET|PRIVATE_KEY|SESSION_SECRET)/.test(
      entry.name,
    )
  ) {
    return false;
  }

  return true;
}

function dedupeEntries(entries) {
  const seen = new Set();

  return entries.filter((entry) => {
    const key = `${entry.name}\u0000${entry.value}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function loadTrackedFileBuffers(repoRoot, trackedFiles) {
  const buffers = [];

  for (const trackedFile of trackedFiles) {
    if (isDisallowedTrackedPath(trackedFile)) {
      continue;
    }

    const absolutePath = path.join(repoRoot, trackedFile);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }

    if (!stat.isFile() || stat.size === 0 || stat.size > 2 * 1024 * 1024) {
      continue;
    }

    let buffer;
    try {
      buffer = fs.readFileSync(absolutePath);
    } catch {
      continue;
    }

    if (buffer.includes(0)) {
      continue;
    }

    buffers.push({
      path: toWorkspacePath(repoRoot, trackedFile),
      buffer,
    });
  }

  return buffers;
}

function toWorkspacePath(repoRoot, trackedFile) {
  return path
    .relative(workspaceRoot, path.join(repoRoot, trackedFile))
    .replaceAll(path.sep, "/");
}

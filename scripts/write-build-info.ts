import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const rootDir = resolveRepoRoot(import.meta.url);
const distDir = path.join(rootDir, "dist");
const pkgPath = path.join(rootDir, "package.json");

interface PackageManifest {
  version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

const readPackageVersion = () => {
  const raw = fs.readFileSync(pkgPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isPackageManifest(parsed)) {
    throw new Error(`package.json is missing a version: ${pkgPath}`);
  }
  return parsed.version;
};

const resolveCommit = () => {
  const envCommit =
    process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }
  return execSync("git rev-parse HEAD", {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
};

const detectChannel = (version: string): string => {
  if (version.includes("-nightly")) return "nightly";
  if (version.includes("-beta")) return "beta";
  if (version.includes("-rc")) return "rc";
  if (version.includes("-")) return "prerelease";
  return "stable";
};

const version = readPackageVersion();
const commit = resolveCommit();
const channel = detectChannel(version);

const buildInfo = {
  version,
  channel,
  commit,
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(
  path.join(distDir, "package.json"),
  `${JSON.stringify({ type: "module" })}\n`,
);
fs.writeFileSync(
  path.join(distDir, "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
);

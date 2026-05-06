import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(rootDir, "dist");
const pkgPath = path.join(rootDir, "package.json");

const readPackageVersion = () => {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
};

const resolveCommit = () => {
  const envCommit =
    process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }
  try {
    return execSync("git rev-parse HEAD", {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const detectChannel = (version: string | null): string => {
  if (!version) return "unknown";
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

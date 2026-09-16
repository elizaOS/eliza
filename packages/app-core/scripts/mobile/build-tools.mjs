/** Owns mobile build process execution, filesystem helpers, and package resolution using the shared build context and existing platform contracts. */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  isCapacitorPlatformReady as isCapacitorPlatformReadyImpl,
  resolvePlatformTemplateRoot as resolvePlatformTemplateRootImpl,
  syncPlatformTemplateFiles as syncPlatformTemplateFilesImpl,
} from "../lib/capacitor-platform-templates.mjs";
import {
  appDir,
  elizaCheckoutRoot,
  nativePluginsDir,
  packagesRoot,
  repoRoot,
} from "./context.mjs";
import { firstExisting, resolveNodeExecutable } from "./toolchain.mjs";

export const RM_PATH_RECURSIVE_SCRIPT = path.join(
  packagesRoot,
  "scripts",
  "rm-path-recursive.mjs",
);

// ── Helpers ─────────────────────────────────────────────────────────────

export const MOBILE_BUILD_NODE_HEAP_OPTION = "--max-old-space-size=6144";

export function withMobileBuildNodeOptions(env = process.env) {
  const current = String(env.NODE_OPTIONS ?? "").trim();
  if (/\b--max-old-space-size(?:=|\s+)/.test(current)) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: [current, MOBILE_BUILD_NODE_HEAP_OPTION]
      .filter(Boolean)
      .join(" "),
  };
}

export function run(command, args, { cwd, env = process.env } = {}) {
  // Windows: gradlew is gradlew.bat, and Node cannot spawn `./gradlew` (ENOENT)
  // nor a .bat/.cmd directly (EINVAL since CVE-2024-27980). Translate
  // ./gradlew -> the sibling gradlew.bat (resolved against cwd) and run any
  // .bat/.cmd through cmd.exe with args as separate argv (no shell:true).
  let spawnCmd = command;
  let spawnArgs = args;
  if (process.platform === "win32") {
    if (command === "./gradlew" || command === "gradlew") {
      spawnCmd = path.join(cwd || process.cwd(), "gradlew.bat");
    }
    if (/.(?:bat|cmd)$/i.test(spawnCmd)) {
      spawnArgs = ["/d", "/s", "/c", spawnCmd, ...args];
      spawnCmd = process.env.ComSpec || "cmd.exe";
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, { cwd, env, stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} killed by ${signal}`));
      if ((code ?? 1) !== 0)
        return reject(new Error(`${command} exited with code ${code ?? 1}`));
      resolve();
    });
  });
}

export function resolveCapacitorCli({
  appDirValue = appDir,
  repoRootValue = repoRoot,
} = {}) {
  const capacitorCliPackage = resolvePackageAbsolutePath("@capacitor/cli", {
    appDirValue,
    repoRootValue,
  });
  const capacitorCli = capacitorCliPackage
    ? path.join(capacitorCliPackage, "bin", "capacitor")
    : null;
  if (!capacitorCli || !fs.existsSync(capacitorCli)) {
    throw new Error("@capacitor/cli not found; run bun install");
  }
  return capacitorCli;
}

export function runCapacitor(args, { env = process.env } = {}) {
  return run(resolveNodeExecutable(), [resolveCapacitorCli(), ...args], {
    cwd: appDir,
    env,
  });
}

export function walkFiles(root, visitor) {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, visitor);
    } else if (entry.isFile()) {
      visitor(filePath);
    }
  }
}

export function runCaptureSync(
  command,
  args,
  { cwd = repoRoot, maxBuffer } = {},
) {
  return spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer,
  });
}

export function rmRecursive(pathToRemove) {
  const result = spawnSync(
    process.execPath,
    [RM_PATH_RECURSIVE_SCRIPT, path.resolve(pathToRemove)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `[mobile-build] failed to recursively remove ${pathToRemove}: ${reason}`,
    );
  }
}

export function resolveViteCli() {
  const viteCli = firstExisting([
    path.join(appDir, "node_modules", ".bin", "vite"),
    path.join(repoRoot, "node_modules", ".bin", "vite"),
    path.join(appDir, "node_modules", "vite", "bin", "vite.js"),
    path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
  ]);
  if (!viteCli) {
    throw new Error("vite CLI not found; run bun install");
  }
  return viteCli;
}

export function prependPath(env, entries) {
  const sep = process.platform === "win32" ? ";" : ":";
  const valid = entries.filter(Boolean);
  return valid.length
    ? `${valid.join(sep)}${sep}${env.PATH ?? ""}`
    : (env.PATH ?? "");
}

export function escapeXcodeBuildSetting(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve the real filesystem path to a node_modules package (follows bun
 * symlinks). Returns a path relative to `relativeTo`.
 */
export function resolvePackagePath(pkgName, relativeTo) {
  const linked = resolvePackageAbsolutePath(pkgName);
  if (!linked) return null;
  return path.relative(relativeTo, linked);
}

export function resolvePackageAbsolutePath(
  pkgName,
  { appDirValue = appDir, repoRootValue = repoRoot } = {},
) {
  const candidates = resolvePackageAbsolutePathCandidates(pkgName, {
    appDirValue,
    repoRootValue,
  });
  const linked = candidates.find((candidate) => fs.existsSync(candidate));
  if (!linked) return null;
  return fs.realpathSync(linked);
}

export function resolvePackageAbsolutePathCandidates(
  pkgName,
  { appDirValue = appDir, repoRootValue = repoRoot } = {},
) {
  const roots = [
    ...new Set(
      [appDirValue, repoRootValue, elizaCheckoutRoot].map((root) =>
        path.resolve(root),
      ),
    ),
  ];
  const candidates = roots.map((root) =>
    path.join(root, "node_modules", ...pkgName.split("/")),
  );
  for (const bunStore of roots.map((root) =>
    path.join(root, "node_modules", ".bun"),
  )) {
    if (!fs.existsSync(bunStore)) continue;
    for (const entry of fs.readdirSync(bunStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(bunStore, entry.name, "node_modules", ...pkgName.split("/")),
      );
    }
  }
  return [
    ...new Set(
      candidates
        .filter((candidate) => fs.existsSync(candidate))
        .map((candidate) => fs.realpathSync(candidate)),
    ),
  ];
}

export function resolveNativePluginPackagePath(pkgName, relativeTo) {
  if (pkgName === "@elizaos/bun-ios-runtime") {
    const localPackageRoot = path.join(packagesRoot, "native", "bun-runtime");
    if (fs.existsSync(path.join(localPackageRoot, "package.json"))) {
      return path.relative(relativeTo, localPackageRoot);
    }
  }
  const match = pkgName.match(/^@elizaos\/capacitor-(.+)$/);
  if (match) {
    const localPluginRoot = path.join(nativePluginsDir, match[1]);
    if (fs.existsSync(path.join(localPluginRoot, "package.json"))) {
      return path.relative(relativeTo, localPluginRoot);
    }
  }
  return resolvePackagePath(pkgName, relativeTo);
}

export function resolvePlatformTemplateRoot(
  platform,
  { repoRootValue = repoRoot } = {},
) {
  return resolvePlatformTemplateRootImpl(platform, { repoRootValue });
}

export function syncPlatformTemplateFiles(
  platform,
  { repoRootValue = repoRoot, appDirValue = appDir, log = console.log } = {},
) {
  return syncPlatformTemplateFilesImpl(platform, {
    repoRootValue,
    appDirValue,
    log,
  });
}

export function isCapacitorPlatformReady(
  platform,
  { appDirValue = appDir } = {},
) {
  return isCapacitorPlatformReadyImpl(platform, { appDirValue });
}

export function replaceInFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;
  for (const [search, replacement] of replacements) {
    content = content.replaceAll(search, replacement);
  }
  if (content === original) return false;
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

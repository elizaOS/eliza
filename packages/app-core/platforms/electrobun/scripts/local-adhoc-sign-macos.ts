#!/usr/bin/env bun
/** Supports Electrobun packaging and signing workflow for app-core desktop builds. */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ExecFileSyncFn = typeof execFileSync;
type SpawnSyncFn = typeof spawnSync;
type EntitlementValue = boolean | string | string[];

function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderPlistValue(value: EntitlementValue): string {
  if (typeof value === "boolean") {
    return value ? "<true/>" : "<false/>";
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((item) => `    <string>${escapePlistString(item)}</string>`)
      .join("\n");
    return `<array>\n${entries}\n  </array>`;
  }
  return `<string>${escapePlistString(value)}</string>`;
}

export function createEntitlementsPlist(
  entitlements: Record<string, EntitlementValue>,
): string {
  const entries = Object.entries(entitlements)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `  <key>${escapePlistString(key)}</key>\n  ${renderPlistValue(value)}`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}

export function parseCodesignIdentifier(output: string): string | null {
  const match = output.match(/^Identifier=(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

export function createAdhocDesignatedRequirement(identifier: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
    throw new Error(`[local-sign] invalid code-sign identifier: ${identifier}`);
  }
  return `=designated => identifier "${identifier}"`;
}

export function shouldApplyLocalAdhocSigning(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return process.platform === "darwin" && env.ELECTROBUN_SKIP_CODESIGN === "1";
}

function readCodesignOutput(
  targetPath: string,
  spawnFile: SpawnSyncFn,
): string {
  const result = spawnFile("codesign", ["-dv", "--verbose=4", targetPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `[local-sign] failed to inspect ${targetPath}: ${result.stderr || result.stdout || "unknown codesign error"}`,
    );
  }

  return `${result.stdout}${result.stderr}`;
}

function runCodesign(
  targetPath: string,
  entitlementsPath: string | null,
  expectedIdentifier: string,
  execFile: ExecFileSyncFn,
): void {
  const entitlementsArgs = entitlementsPath
    ? ["--entitlements", entitlementsPath]
    : [];
  execFile(
    "codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      expectedIdentifier,
      "--requirements",
      createAdhocDesignatedRequirement(expectedIdentifier),
      "--options",
      "runtime",
      ...entitlementsArgs,
      targetPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function isLocalAppPermissionHost(
  appBundlePath: string,
  targetPath: string,
): boolean {
  const relative = path
    .relative(appBundlePath, targetPath)
    .split(path.sep)
    .join("/");
  return (
    relative === "" ||
    relative === "Contents/MacOS/launcher" ||
    relative === "Contents/MacOS/bun"
  );
}

export function localCodeSignIdentifier(
  appBundlePath: string,
  targetPath: string,
  appIdentifier: string,
): string {
  if (isLocalAppPermissionHost(appBundlePath, targetPath)) {
    return appIdentifier;
  }
  const relative = path
    .relative(appBundlePath, targetPath)
    .split(path.sep)
    .join("-")
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!relative) {
    throw new Error(
      `[local-sign] cannot derive helper identity: ${targetPath}`,
    );
  }
  return `${appIdentifier}.helper.${relative}`;
}

function readCodesignRequirement(
  targetPath: string,
  spawnFile: SpawnSyncFn,
): string {
  const result = spawnFile("codesign", ["-dr", "-", targetPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[local-sign] failed to inspect designated requirement for ${targetPath}: ${result.stderr || result.stdout || "unknown codesign error"}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

export function collectMacCodeSignTargets(appBundlePath: string): string[] {
  const binaryDir = path.join(appBundlePath, "Contents", "MacOS");
  return [
    path.join(binaryDir, "libNativeWrapper.dylib"),
    path.join(binaryDir, "libwebgpu_dawn.dylib"),
    path.join(binaryDir, "libasar.dylib"),
    path.join(binaryDir, "bun"),
    path.join(binaryDir, "extractor"),
    path.join(binaryDir, "process_helper"),
    path.join(binaryDir, "zig-zstd"),
    path.join(binaryDir, "zig-asar"),
    path.join(binaryDir, "bspatch"),
    path.join(binaryDir, "bsdiff"),
    path.join(binaryDir, "launcher"),
    appBundlePath,
  ].filter((target, index, targets) => targets.indexOf(target) === index);
}

export function signLocalAppBundle(args: {
  appBundlePath: string;
  entitlements: Record<string, EntitlementValue>;
  expectedIdentifier: string;
  execFile?: ExecFileSyncFn;
  spawnFile?: SpawnSyncFn;
}): void {
  const execFile = args.execFile ?? execFileSync;
  const spawnFile = args.spawnFile ?? spawnSync;
  const appBundlePath = path.resolve(args.appBundlePath);
  const launcherPath = path.join(
    appBundlePath,
    "Contents",
    "MacOS",
    "launcher",
  );

  if (!fs.existsSync(appBundlePath)) {
    throw new Error(`[local-sign] app bundle not found: ${appBundlePath}`);
  }
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`[local-sign] launcher not found: ${launcherPath}`);
  }

  const entitlementsPath = path.join(
    os.tmpdir(),
    `elizaos-local-entitlements-${process.pid}-${Date.now()}.plist`,
  );

  fs.writeFileSync(
    entitlementsPath,
    createEntitlementsPlist(args.entitlements),
    "utf8",
  );

  try {
    const signTargets = collectMacCodeSignTargets(appBundlePath).filter(
      (target) => fs.existsSync(target),
    );

    for (const target of signTargets) {
      const identifier = localCodeSignIdentifier(
        appBundlePath,
        target,
        args.expectedIdentifier,
      );
      runCodesign(
        target,
        isLocalAppPermissionHost(appBundlePath, target)
          ? entitlementsPath
          : null,
        identifier,
        execFile,
      );
    }

    for (const target of signTargets) {
      const expectedTargetIdentifier = localCodeSignIdentifier(
        appBundlePath,
        target,
        args.expectedIdentifier,
      );
      const codesignOutput = readCodesignOutput(target, spawnFile);
      const identifier = parseCodesignIdentifier(codesignOutput);
      if (identifier !== expectedTargetIdentifier) {
        throw new Error(
          `[local-sign] expected ${target} identifier ${expectedTargetIdentifier}, got ${identifier ?? "unknown"}`,
        );
      }
      const requirement = readCodesignRequirement(target, spawnFile);
      if (!requirement.includes(`identifier "${expectedTargetIdentifier}"`)) {
        throw new Error(
          `[local-sign] ${target} lacks the stable designated requirement for ${expectedTargetIdentifier}`,
        );
      }
    }

    execFile("codesign", ["--verify", "--deep", "--strict", appBundlePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    fs.rmSync(entitlementsPath, { force: true });
  }
}

async function main(): Promise<void> {
  const appBundlePath = process.argv[2];
  if (!appBundlePath) {
    throw new Error(
      "Usage: bun scripts/local-adhoc-sign-macos.ts /path/to/the app.app",
    );
  }

  const electrobunConfig = (await import("../electrobun.config")).default;
  const entitlements = electrobunConfig.build?.mac?.entitlements;
  if (!entitlements) {
    throw new Error(
      "[local-sign] missing macOS entitlements in Electrobun config",
    );
  }
  signLocalAppBundle({
    appBundlePath,
    entitlements,
    expectedIdentifier: electrobunConfig.app.identifier,
  });
  console.log(`[local-sign] signed ${path.resolve(appBundlePath)}`);
}

if (import.meta.main) {
  await main();
}

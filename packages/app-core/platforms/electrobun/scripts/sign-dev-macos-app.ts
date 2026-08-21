#!/usr/bin/env bun
/** Ad-hoc signs the completed macOS development bundle so OS permission services can bind it to Eliza's bundle identity. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import electrobunConfig from "../electrobun.config";
import { signLocalAppBundle } from "./local-adhoc-sign-macos";
import { resolveWrapperBundlePath } from "./postwrap-diagnostics";

export function shouldSignDevMacApp(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform = process.platform,
): boolean {
  return (
    hostPlatform === "darwin" &&
    env.ELECTROBUN_BUILD_ENV === "dev" &&
    env.ELECTROBUN_OS === "macos" &&
    env.ELECTROBUN_SKIP_CODESIGN === "1"
  );
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ELECTROBUN_OS !== "macos") return;

  const appBundlePath = resolveWrapperBundlePath([], env);
  if (!shouldSignDevMacApp(env)) {
    const profilePath = path.join(
      appBundlePath,
      "Contents",
      "embedded.provisionprofile",
    );
    if (!fs.existsSync(profilePath)) return;
    const entitlements = execFileSync(
      "codesign",
      ["-d", "--entitlements", ":-", "--xml", appBundlePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (
      !entitlements.includes("com.apple.security.application-groups") ||
      !entitlements.includes("group.ai.elizaos.browserbridge") ||
      entitlements.includes("$(AppIdentifierPrefix)")
    ) {
      throw new Error(
        "[release-sign] effective App Group entitlement is missing or unresolved",
      );
    }
    execFileSync(
      "codesign",
      ["--verify", "--deep", "--strict", appBundlePath],
      {
        stdio: "pipe",
      },
    );
    console.log(
      `[release-sign] verified effective App Group entitlement and embedded profile for ${path.resolve(appBundlePath)}`,
    );
    return;
  }

  const entitlements = electrobunConfig.build?.mac?.entitlements;
  if (!entitlements) {
    throw new Error(
      "[dev-sign] missing macOS entitlements in Electrobun config",
    );
  }

  signLocalAppBundle({
    appBundlePath,
    entitlements,
    expectedIdentifier: electrobunConfig.app.identifier,
  });
  console.log(`[dev-sign] signed ${path.resolve(appBundlePath)}`);
}

if (import.meta.main) {
  main();
}

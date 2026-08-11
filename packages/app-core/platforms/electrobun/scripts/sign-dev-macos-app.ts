#!/usr/bin/env bun
/** Ad-hoc signs the completed macOS development bundle so OS permission services can bind it to Eliza's bundle identity. */

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
  if (!shouldSignDevMacApp(env)) return;

  const entitlements = electrobunConfig.build?.mac?.entitlements;
  if (!entitlements) {
    throw new Error(
      "[dev-sign] missing macOS entitlements in Electrobun config",
    );
  }

  const appBundlePath = resolveWrapperBundlePath([], env);
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

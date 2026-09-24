#!/usr/bin/env node
/** Runs the shared native builder with the app development entrypoint's full-build and legacy manifest policy. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNativePlugins,
  shouldBuildPluginForHost as canonicalHostFilter,
} from "./build-native-plugins.mjs";

export { OS_PLATFORMS } from "./build-native-plugins.mjs";

/** Accepts the older app manifest namespace before applying the shared host policy. */
export function shouldBuildPluginForHost(pkg, hostPlatform) {
  if (pkg && typeof pkg === "object" && pkg.eliza?.platforms != null) {
    return canonicalHostFilter(
      { ...pkg, elizaos: { ...pkg.elizaos, platforms: pkg.eliza.platforms } },
      hostPlatform,
    );
  }
  return canonicalHostFilter(pkg, hostPlatform);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildNativePlugins({
    force: true,
    sourceRuntime: process.env.ELIZA_DEV_SOURCE === "1",
    hostFilter: shouldBuildPluginForHost,
  });
}

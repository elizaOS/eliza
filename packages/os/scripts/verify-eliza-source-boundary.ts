#!/usr/bin/env node
/**
 * Enforces the repository split against an eliza application checkout.
 * OS distribution and image toolchains must be absent there, while mobile app
 * shells and their runtime-native integrations remain required application code.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const osRepositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const elizaRoot = path.resolve(
  process.env.ELIZAOS_ELIZA_ROOT ??
    path.join(osRepositoryRoot, ".eliza-source"),
);

if (!fs.existsSync(path.join(elizaRoot, ".git"))) {
  throw new Error(
    `Set ELIZAOS_ELIZA_ROOT to an elizaOS/eliza checkout (received ${elizaRoot}).`,
  );
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: elizaRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const forbiddenPrefixes = [
  "packages/os/",
  "packages/app-core/packaging/debian/",
  "packages/app-core/scripts/bun-riscv64/",
  "scripts/distro-android/",
];
const forbiddenPaths = new Set([
  "scripts/README.riscv64-smoke.md",
  "plugins/plugin-local-inference/native/verify/cuttlefish_x86_64_smoke.sh",
  "packages/native/cmake/toolchain-android-riscv64.cmake",
  "packages/native/cmake/toolchain-riscv64-linux-gnu.cmake",
  "packages/native/cmake/toolchain-riscv64-linux-musl.cmake",
]);
const forbiddenWorkflowNames = new Set([
  "build-debian-package.yml",
  "build-linux-mkosi.yml",
  "build-linux-iso.yml",
  "build-vm-image.yml",
  "elizaos-cuttlefish.yml",
  "elizaos-os-full-release.yml",
  "elizaos-os-release.yml",
  "publish-aosp-update-manifest.yml",
  "publish-apt-repo.yml",
  "release-elizaos-setup.yml",
  "release-usb-installer.yml",
  "riscv64-smoke.yml",
  "test-elizaos-setup.yml",
  "update-os-release-manifest.yml",
  "update-vendor-checksums.yml",
]);
const forbiddenWorkflowReferences = [
  "ElizaOS Cuttlefish",
  "ElizaOS OpenAgent E1",
  "publish-apt-repo.yml",
];

const forbidden = tracked.filter(
  (entry) =>
    forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)) ||
    forbiddenPaths.has(entry) ||
    (entry.startsWith(".github/workflows/") &&
      forbiddenWorkflowNames.has(path.basename(entry))),
);
if (forbidden.length > 0) {
  throw new Error(
    `OS-owned paths are tracked in eliza:\n${forbidden.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

const workflowReferenceResiduals = tracked
  .filter((entry) => entry.startsWith(".github/workflows/"))
  .flatMap((entry) => {
    const contents = fs.readFileSync(path.join(elizaRoot, entry), "utf8");
    return forbiddenWorkflowReferences
      .filter((reference) => contents.includes(reference))
      .map((reference) => `${entry}: ${reference}`);
  });
if (workflowReferenceResiduals.length > 0) {
  throw new Error(
    `Moved OS workflow references remain in eliza CI:\n${workflowReferenceResiduals.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

const ownershipConfigChecks = [
  [".dockerignore", /^packages\/os(?:\/|$)/m],
  [".gitignore", /^\/?packages\/os(?:\/|$)/m],
  [".gitignore", /^packages\/app-core\/scripts\/bun-riscv64(?:\/|$)/m],
  ["package.json", /"packages\/os\/\*"/],
  ["AGENTS.md", /packages\/os\/\*/],
  ["CLAUDE.md", /packages\/os\/\*/],
  ["README.md", /\]\(packages\/os(?:\/|\))/],
  [".github/actionlint.yaml", /^\s*-\s*kvm\s*$/m],
];
const ownershipConfigResiduals = ownershipConfigChecks.flatMap(
  ([entry, pattern]) => {
    const contents = fs.readFileSync(path.join(elizaRoot, entry), "utf8");
    return pattern.test(contents) ? [`${entry}: ${pattern}`] : [];
  },
);
if (ownershipConfigResiduals.length > 0) {
  throw new Error(
    `Source configuration still owns local OS paths:\n${ownershipConfigResiduals.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

const requiredAppPrefixes = [
  "packages/app-core/platforms/android/",
  "packages/app-core/platforms/ios/",
  "packages/native/plugins/",
  "plugins/plugin-native-",
  "plugins/plugin-capacitor-bridge/android/",
];
for (const prefix of requiredAppPrefixes) {
  if (!tracked.some((entry) => entry.startsWith(prefix))) {
    throw new Error(`Required app-native ownership path is missing: ${prefix}`);
  }
}

const allowedOsNamedAppPaths = new Set([
  "plugins/plugin-capacitor-bridge/android/src/main/java/ai/elizaos/computeruse/AospPrivilegedBridge.kt",
  "plugins/plugin-computeruse/docs/AOSP_SYSTEM_APP.md",
  "plugins/plugin-computeruse/docs/android-aosp-validation.json",
  "plugins/plugin-computeruse/src/__tests__/aosp-input-actor.test.ts",
  "plugins/plugin-computeruse/src/actor/aosp-input-actor.ts",
  "plugins/plugin-local-inference/src/runtime/aosp-llama-loader-selection.test.ts",
  "plugins/plugin-local-inference/src/services/imagegen/aosp-unavailable.ts",
  "plugins/plugin-local-inference/src/services/vision/aosp-unavailable.ts",
  "plugins/plugin-native-inference/__tests__/aosp-abi-riscv64.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-audio-resample.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-embedding-artifact.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-fused-text-binding.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-kokoro-tts-handler.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-llama-streaming.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-local-inference-bootstrap.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-model-download-paths.test.ts",
  "plugins/plugin-native-inference/src/aosp-audio-resample.ts",
  "plugins/plugin-native-inference/src/aosp-debug-log.ts",
  // App-runtime model admission and bundle staging; no OS image tooling.
  "plugins/plugin-native-inference/src/aosp-embedding-artifact.ts",
  "plugins/plugin-native-inference/src/aosp-llama-paths.ts",
  "plugins/plugin-native-inference/src/aosp-llama-streaming.ts",
  "plugins/plugin-native-inference/src/aosp-local-inference-bootstrap.ts",
  "plugins/plugin-native-inference/src/aosp-model-paths.ts",
]);
const osNamedPluginOrNativePaths = tracked.filter(
  (entry) =>
    (entry.startsWith("plugins/") || entry.startsWith("packages/native/")) &&
    /(?:^|\/)(?:[^/]*aosp[^/]*|[^/]*cuttlefish[^/]*|[^/]*debian[^/]*|[^/]*riscv64[^/]*)/i.test(
      entry,
    ),
);
const unclassified = osNamedPluginOrNativePaths.filter(
  (entry) => !allowedOsNamedAppPaths.has(entry),
);
if (unclassified.length > 0) {
  throw new Error(
    `New OS-named plugin/native paths require an ownership decision:\n${unclassified.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

console.log(
  `eliza source boundary passed: ${tracked.length} tracked paths, ${allowedOsNamedAppPaths.size} classified app-runtime AOSP paths.`,
);

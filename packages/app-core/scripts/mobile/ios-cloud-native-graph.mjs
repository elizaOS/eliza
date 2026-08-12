/**
 * Reconciles Capacitor plugin registration and audits the generated iOS graph
 * for the pure-cloud target. The audit runs after CocoaPods and immediately
 * before Xcode so an incrementally reused native tree cannot retain executable
 * local-agent dependencies that the target policy forbids.
 */
import fs from "node:fs";
import path from "node:path";

import { ElizaError } from "../lib/eliza-error.mjs";

export const IOS_LOCAL_EXECUTION_PLUGIN_CLASSES = Object.freeze([
  "ElizaBunRuntimePlugin",
  "MobileAgentBridgePlugin",
  "LlamaCppPlugin",
]);

export const IOS_LOCAL_EXECUTION_NATIVE_IDENTIFIERS = Object.freeze([
  "ElizaosCapacitorBunRuntime",
  "ElizaBunEngine",
  "ElizaosCapacitorMobileAgentBridge",
  "LlamaCppCapacitor",
]);

const CAPACITOR_CONFIG_RELATIVE_PATH = path.join(
  "App",
  "capacitor.config.json",
);

const REQUIRED_IOS_CLOUD_GRAPH_FILES = Object.freeze([
  "Podfile",
  "Podfile.lock",
  path.join("App.xcodeproj", "project.pbxproj"),
  path.join("Pods", "Manifest.lock"),
  path.join("Pods", "Pods.xcodeproj", "project.pbxproj"),
  CAPACITOR_CONFIG_RELATIVE_PATH,
]);

const TEXT_IOS_CLOUD_GRAPH_FILES = Object.freeze([
  ...REQUIRED_IOS_CLOUD_GRAPH_FILES.filter(
    (relativePath) => relativePath !== CAPACITOR_CONFIG_RELATIVE_PATH,
  ),
  path.join("CapApp-SPM", "Package.swift"),
  path.join(
    "Pods",
    "Target Support Files",
    "Pods-App",
    "Pods-App-frameworks.sh",
  ),
  path.join(
    "Pods",
    "Target Support Files",
    "Pods-App",
    "Pods-App.debug.xcconfig",
  ),
  path.join(
    "Pods",
    "Target Support Files",
    "Pods-App",
    "Pods-App.release.xcconfig",
  ),
]);

function graphError(message, { cause, context } = {}) {
  return new ElizaError(message, {
    cause,
    code: "IOS_CLOUD_NATIVE_GRAPH_INVALID",
    context: { subsystem: "mobile-build", ...context },
    severity: "fatal",
  });
}

function readCapacitorConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (cause) {
    // error-policy:J2 generated native configuration is required build input
    throw graphError(
      `[mobile-build] Failed to parse iOS capacitor config: ${configPath}`,
      { cause, context: { configPath } },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw graphError(
      `[mobile-build] iOS capacitor config must contain an object: ${configPath}`,
      { context: { configPath } },
    );
  }
  return parsed;
}

function capacitorPluginClassList(config, configPath) {
  const value = config.packageClassList;
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw graphError(
      `[mobile-build] iOS capacitor packageClassList must contain only strings: ${configPath}`,
      { context: { configPath } },
    );
  }
  return value;
}

/** Applies one authoritative class allow/deny decision to generated config. */
export function reconcileIosCapacitorPluginClasses(
  configPath,
  { required = [], forbidden = [] } = {},
) {
  if (!fs.existsSync(configPath)) return false;
  const overlap = required.filter((pluginClass) =>
    forbidden.includes(pluginClass),
  );
  if (overlap.length > 0) {
    throw graphError(
      `[mobile-build] iOS Capacitor class policy both requires and forbids: ${overlap.join(", ")}`,
      { context: { configPath, overlap } },
    );
  }

  const config = readCapacitorConfig(configPath);
  const classList = capacitorPluginClassList(config, configPath);
  const forbiddenSet = new Set(forbidden);
  const next = classList.filter(
    (pluginClass) => !forbiddenSet.has(pluginClass),
  );
  for (const pluginClass of required) {
    if (!next.includes(pluginClass)) next.push(pluginClass);
  }
  if (
    next.length === classList.length &&
    next.every((pluginClass, index) => pluginClass === classList[index])
  ) {
    return false;
  }
  config.packageClassList = next;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
  return true;
}

function enabledConfigFlag(value) {
  return (
    value === true || /^(1|true|yes|on)$/i.test(String(value ?? "").trim())
  );
}

/** Returns every generated-graph violation without mutating the native tree. */
export function inspectIosCloudNativeGraph(iosRoot) {
  if (typeof iosRoot !== "string" || iosRoot.trim().length === 0) {
    throw graphError("[mobile-build] iOS native graph root is required");
  }
  const findings = [];
  for (const relativePath of REQUIRED_IOS_CLOUD_GRAPH_FILES) {
    if (!fs.existsSync(path.join(iosRoot, relativePath))) {
      findings.push(`missing generated native graph file: ${relativePath}`);
    }
  }

  for (const relativePath of TEXT_IOS_CLOUD_GRAPH_FILES) {
    const filePath = path.join(iosRoot, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    for (const identifier of IOS_LOCAL_EXECUTION_NATIVE_IDENTIFIERS) {
      if (content.includes(identifier)) {
        findings.push(`${relativePath} references ${identifier}`);
      }
    }
  }

  const configPath = path.join(iosRoot, CAPACITOR_CONFIG_RELATIVE_PATH);
  if (fs.existsSync(configPath)) {
    const config = readCapacitorConfig(configPath);
    const classList = capacitorPluginClassList(config, configPath);
    for (const pluginClass of IOS_LOCAL_EXECUTION_PLUGIN_CLASSES) {
      if (classList.includes(pluginClass)) {
        findings.push(
          `${path.relative(iosRoot, configPath)} registers ${pluginClass}`,
        );
      }
    }
    const agentConfig = config.plugins?.Agent;
    if (!agentConfig || typeof agentConfig !== "object") {
      findings.push("capacitor Agent runtime config is missing");
    } else {
      if (agentConfig.runtimeMode !== "cloud") {
        findings.push(
          `capacitor Agent runtimeMode is ${JSON.stringify(agentConfig.runtimeMode)} instead of "cloud"`,
        );
      }
      if (enabledConfigFlag(agentConfig.fullBunAvailable)) {
        findings.push("capacitor Agent fullBunAvailable is enabled");
      }
    }
  }

  const publicDir = path.join(iosRoot, "App", "public");
  for (const relativePath of [
    "agent",
    "vector.tar.gz",
    "fuzzystrmatch.tar.gz",
  ]) {
    if (fs.existsSync(path.join(publicDir, relativePath))) {
      findings.push(`App/public retains local payload: ${relativePath}`);
    }
  }
  return findings;
}

/** Fails the build before Xcode can consume a contaminated pure-cloud graph. */
export function assertIosCloudNativeGraph(iosRoot) {
  const findings = inspectIosCloudNativeGraph(iosRoot);
  if (findings.length === 0) return;
  throw graphError(
    `[mobile-build] ios-cloud native graph retains forbidden local execution state:\n${findings
      .map((finding) => `  - ${finding}`)
      .join("\n")}`,
    { context: { iosRoot, findings } },
  );
}

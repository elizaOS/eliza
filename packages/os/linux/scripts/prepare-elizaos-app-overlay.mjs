#!/usr/bin/env node
// Supports Linux live-image build and release evidence automation.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function parseArgs(argv) {
  let parsedCheck = false;
  let parsedStage;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      parsedCheck = true;
      continue;
    }
    if (arg === "--stage") {
      parsedStage = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--stage=")) {
      parsedStage = arg.slice("--stage=".length);
      continue;
    }
    if (!arg.startsWith("--") && !parsedStage) {
      parsedStage = arg;
    }
  }

  return { check: parsedCheck, stageArg: parsedStage };
}

const { check, stageArg } = parseArgs(args);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultStage = path.join(
  root,
  "tails/config/chroot_local-includes/usr/share/elizaos/elizaos-app",
);
const stage = path.resolve(
  stageArg ?? process.env.ELIZAOS_APP_STAGE ?? defaultStage,
);
const buildJsonPath = path.join(stage, "Resources/build.json");
const versionJsonPath = path.join(stage, "Resources/version.json");
const infoPlistPath = path.join(stage, "Info.plist");
const brandConfigPath = path.join(stage, "Resources/app/brand-config.json");
const overlayManifestPath = path.join(
  stage,
  "Resources/app/elizaos-live-overlay-manifest.json",
);
const rendererRoot = path.join(stage, "Resources/app/renderer");
const officialAssetRoot = path.join(root, "assets");
const rendererWallpaperPath = path.join(
  root,
  "tails/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png",
);
const agentPackageJsonPath = path.join(
  stage,
  "Resources/app/eliza-dist/node_modules/@elizaos/agent/package.json",
);
const nodeModulesPath = path.join(
  stage,
  "Resources/app/eliza-dist/node_modules",
);
const lucideSentinelExports = ["Feather", "Loader2", "Maximize2", "Settings"];
const dependencyTargets = [
  {
    linkPath: path.join(stage, "node_modules"),
    target: "Resources/app/eliza-dist/node_modules",
  },
  {
    linkPath: path.join(stage, "bin/node_modules"),
    target: "../Resources/app/eliza-dist/node_modules",
  },
];

function findWorkspaceRoot() {
  for (
    let current = root;
    current && current !== path.dirname(current);
    current = path.dirname(current)
  ) {
    if (
      fs.existsSync(path.join(current, "plugins/plugin-health/package.json"))
    ) {
      return current;
    }
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot();
const rmPathRecursiveScriptPath = workspaceRoot
  ? path.join(workspaceRoot, "packages/scripts/rm-path-recursive.mjs")
  : null;
const existingOverlayManifest = fs.existsSync(overlayManifestPath)
  ? JSON.parse(fs.readFileSync(overlayManifestPath, "utf8"))
  : null;

function removePathRecursive(targetPath) {
  if (!rmPathRecursiveScriptPath || !fs.existsSync(rmPathRecursiveScriptPath)) {
    throw new Error(
      "Unable to locate packages/scripts/rm-path-recursive.mjs for recursive cleanup.",
    );
  }
  execFileSync(process.execPath, [rmPathRecursiveScriptPath, targetPath], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
}

const liveAgentOrchestratorStub = `
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

const OPS = [
  "status",
  "privacy_mode",
  "root_status",
  "open_persistent_storage",
];

const RUNNER_COMMANDS = {
  status: "status",
  privacy_mode: "privacy-mode",
  root_status: "root-status",
  open_persistent_storage: "open-persistent-storage",
};

function normalizeOp(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\\s-]+/g, "_");
  return OPS.includes(normalized) ? normalized : undefined;
}

function record(value) {
  return value && typeof value === "object" ? value : {};
}

function runnerPath() {
  const configured = process.env.ELIZAOS_CAPABILITY_RUNNER?.trim();
  return configured || "/usr/local/lib/elizaos/capability-runner";
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runBroker(runner, command) {
  return new Promise((resolve, reject) => {
    execFile(
      runner,
      [command],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function keyValues(stdout) {
  return Object.fromEntries(
    stdout
      .split(/\\r?\\n/)
      .map((line) => line.split("="))
      .filter((parts) => parts.length >= 2 && parts[0]),
  );
}

function resultText(op, stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return \`elizaOS \${op} completed.\`;
  if (op === "privacy_mode") return \`elizaOS privacy mode: \${trimmed}\`;
  return \`elizaOS \${op.replace(/_/g, " ")}:\\n\${trimmed}\`;
}

function failureText(error) {
  if (error && typeof error === "object") {
    if (typeof error.stderr === "string" && error.stderr.trim()) {
      return error.stderr.trim();
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }
  }
  return "elizaOS capability broker failed.";
}

export const elizaOsCapabilityAction = {
  name: "ELIZAOS",
  contexts: ["automation", "agent_internal", "settings"],
  roleGate: { minRole: "USER" },
  similes: [
    "ELIZAOS_STATUS",
    "ELIZAOS_PRIVACY_MODE",
    "ELIZAOS_ROOT_STATUS",
    "ELIZAOS_PERSISTENT_STORAGE",
    "OPEN_PERSISTENT_STORAGE",
  ],
  description:
    "Call the local elizaOS Live capability broker. Supported actions: status, privacy_mode, root_status, open_persistent_storage.",
  descriptionCompressed:
    "elizaOS Live broker: status|privacy_mode|root_status|open_persistent_storage",
  parameters: [
    {
      name: "action",
      description:
        "Operation: status, privacy_mode, root_status, open_persistent_storage.",
      required: true,
      schema: { type: "string", enum: OPS },
    },
  ],
  validate: async () => isExecutable(runnerPath()),
  handler: async (_runtime, message, _state, options, callback) => {
    const params = record(options?.parameters);
    const content = record(message?.content);
    const op =
      normalizeOp(params.action) ??
      normalizeOp(params.op) ??
      normalizeOp(content.action) ??
      "status";
    const runner = runnerPath();

    if (!(await isExecutable(runner))) {
      const text = "elizaOS capability broker is not available in this runtime.";
      return { success: false, error: text, text };
    }

    try {
      const { stdout } = await runBroker(runner, RUNNER_COMMANDS[op]);
      const text = resultText(op, stdout);
      if (callback) await callback({ text });
      return { success: true, text, data: { action: op, values: keyValues(stdout) } };
    } catch (error) {
      const text = failureText(error);
      if (callback) await callback({ text });
      return { success: false, error: text, text };
    }
  },
};

export const plugin = {
  name: "agent-orchestrator",
  description:
    "elizaOS Live OS bridge. Full coding-agent orchestration is disabled in the live USB; the constrained capability broker remains available.",
  actions: [elizaOsCapabilityAction],
};

export default plugin;
`;

const optionalStubPackages = new Map(
  Object.entries({
    "@elizaos/app-model-tester": `
export const modelTesterPlugin = {
  name: "model-tester",
  description: "Model tester routes are not bundled in elizaOS Live.",
  routes: [],
};
export default modelTesterPlugin;
`,
    "@elizaos/plugin-personal-assistant": `
export const personalAssistantPlugin = {
  name: "lifeops",
  description: "Live-safe LifeOps overlay for elizaOS Live. Cloud connectors and proactive workflows become available after provider setup.",
  actions: [],
  providers: [],
  services: [],
  routes: [],
};
export const personalAssistantPlugin = {
  name: "lifeops-routes",
  routes: [],
};
export const BrowserBridgePluginService = undefined;
export const browserBridgeProvider = undefined;
export const detectHealthBackend = () => ({ available: false, backend: "none" });
export const handleLifeOpsRoutes = async () => false;
export const handleWebsiteBlockerRoutes = async () => false;
export default personalAssistantPlugin;
`,
    "@elizaos/plugin-documents": `
export const documentsPlugin = {
  name: "documents",
  description: "Documents app routes are not bundled in the elizaOS Live base runtime.",
  routes: [],
};
export const plugin = documentsPlugin;
export default documentsPlugin;
`,
    "@elizaos/plugin-hyperliquid": `
export const hyperliquidPlugin = {
  name: "hyperliquid",
  description: "Hyperliquid app routes are not bundled in the elizaOS Live base runtime.",
  routes: [],
};
export const plugin = hyperliquidPlugin;
export default hyperliquidPlugin;
`,
    "@elizaos/plugin-polymarket": `
export const polymarketPlugin = {
  name: "polymarket",
  description: "Polymarket app routes are not bundled in the elizaOS Live base runtime.",
  routes: [],
};
export const plugin = polymarketPlugin;
export default polymarketPlugin;
`,
    "@elizaos/plugin-shopify": `
export const shopifyPlugin = {
  name: "shopify",
  routes: [],
};
export default shopifyPlugin;
`,
    "@elizaos/plugin-training": `
export const trainingPlugin = {
  name: "training",
  routes: [],
};
export const registerTrainingRuntimeHooks = async () => undefined;
export default trainingPlugin;
`,
    "@elizaos/plugin-whatsapp": `
const inert = () => undefined;
const falseRoute = async () => false;

export const WHATSAPP_MAX_PAIRING_SESSIONS = 0;
export const applyWhatsAppQrOverride = inert;
export const handleWhatsAppRoute = falseRoute;
export const sanitizeWhatsAppAccountId = (value) =>
  typeof value === "string" ? value.trim() : "";
export class WhatsAppPairingSession {
  constructor() {
    this.status = { state: "unavailable" };
  }
  start() {
    return Promise.resolve(this.status);
  }
  stop() {
    return Promise.resolve(this.status);
  }
  snapshot() {
    return this.status;
  }
}
export const whatsappAuthExists = async () => false;
export const whatsappLogout = async () => false;
export default undefined;
`,
    "@elizaos/plugin-streaming": `
let streamSettings = {};
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const falseRoute = async () => false;
const destination = (id, name = id) => ({
  id,
  name,
  enabled: false,
  start: async () => undefined,
  stop: async () => undefined,
});

export function readStreamSettings() {
  return { ...streamSettings };
}
export function validateStreamSettings(value) {
  if (value == null) return { settings: {} };
  if (!isRecord(value)) return { error: "Stream settings must be an object" };
  return { settings: { ...value } };
}
export function writeStreamSettings(value) {
  streamSettings = isRecord(value) ? { ...value } : {};
  return readStreamSettings();
}
export const handleTtsRoutes = falseRoute;
export const handleStreamRoute = falseRoute;
export const streamManager = {
  attach: () => undefined,
  broadcast: () => undefined,
  getActiveDestination: () => undefined,
  list: () => [],
  setActiveDestination: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};
export const createCustomRtmpDestination = () => destination("custom", "Custom RTMP");
export const createNamedRtmpDestination = (params = {}) =>
  destination(params.id ?? "named", params.name ?? "Named RTMP");
export const createTwitchDestination = () => destination("twitch", "Twitch");
export const createYoutubeDestination = () => destination("youtube", "YouTube");
export const createPumpfunDestination = () => destination("pumpfun", "Pump.fun");
export const createXStreamDestination = () => destination("x", "X");
export default undefined;
`,
    "@elizaos/plugin-x402": `
export const isRoutePaymentWrapped = () => false;
export const createPaymentAwareHandler = (route = {}) =>
  route.handler ?? route.routeHandler ?? (async () => undefined);
export const validateX402Startup = () => ({
  valid: true,
  errors: [],
  warnings: [],
});
export default undefined;
`,
    "@elizaos/plugin-mcp": `
export const handleMcpRoutes = async () => false;
export default undefined;
`,
    "@elizaos/plugin-imessage": `
export const resolveBlueBubblesWebhookPath = () => "/api/bluebubbles/webhook";
export default undefined;
`,
    "@elizaos/plugin-google": `
export const googlePlugin = {
  name: "google",
  description: "Live-safe Google connector shell for elizaOS Live. OAuth setup can install the full connector package.",
  actions: [],
  providers: [],
  services: [],
};
export default googlePlugin;
`,
    "@elizaos/plugin-capacitor-bridge": `
const disabledStatus = {
  enabled: false,
  connected: false,
  devices: [],
  primaryDeviceId: null,
  pendingRequests: 0,
  modelPath: null,
};

export const attachMobileDeviceBridgeToServer = async () => undefined;
export const ensureMobileDeviceBridgeInferenceHandlers = async () => false;
export const getMobileDeviceBridgeStatus = () => ({ ...disabledStatus });
export const loadMobileDeviceBridgeModel = async () => undefined;
export const unloadMobileDeviceBridgeModel = async () => undefined;
export default undefined;
`,
    "@elizaos/plugin-aosp-local-inference": `
export const registerAospLlamaLoader = () => undefined;
export const ensureAospLocalInferenceHandlers = () => undefined;
export default undefined;
`,
    "@elizaos/plugin-background-runner": `
export default undefined;
`,
  }).map(([packageName, source]) => [packageName, `${source.trimStart()}\n`]),
);

const forceLiveStubPackages = new Set([
  "@elizaos/app-model-tester",
  "@elizaos/plugin-documents",
  "@elizaos/plugin-google",
  "@elizaos/plugin-hyperliquid",
  "@elizaos/plugin-personal-assistant",
  "@elizaos/plugin-polymarket",
  "@elizaos/plugin-shopify",
  "@elizaos/plugin-training",
]);

const chromiumFlags = {
  "disable-gpu": true,
  "disable-gpu-compositing": true,
  "disable-gpu-sandbox": true,
  "disable-vulkan": true,
  "disable-features": "Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
  "enable-software-rasterizer": true,
  "force-software-rasterizer": true,
  "use-gl": "swiftshader",
  "use-angle": "swiftshader",
  "disable-dev-shm-usage": true,
  "user-data-dir": "/home/amnesia/.cache/org.elizaos.app/dev/CEF/partitions",
};

const liveBrandConfig = {
  appName: "elizaOS",
  appId: "org.elizaos.app",
  namespace: "eliza",
  urlScheme: "elizaos",
  configDirName: "elizaOS",
  appDescription: "AI agents for elizaOS Live",
  buildVariant: "direct",
  configExportFileName: "eliza-config.json",
  startupLogFileName: "eliza-startup.log",
  linuxDesktopFileName: "elizaos.desktop",
  linuxDesktopEntryName: "elizaOS",
  cefVersionMarkerFileName: ".eliza-version",
  runtimeDistDirName: "eliza-dist",
  browserWorkspacePartition: "persist:eliza-browser",
  releaseNotesPartition: "persist:eliza-release-notes",
  cefDesktopPartition: "persist:eliza-desktop-cef",
  trustedCloseMessageType: "eliza.trusted-eliza-window.close",
};

if (!fs.existsSync(buildJsonPath)) {
  console.error(`elizaOS Electrobun build.json not found: ${buildJsonPath}`);
  process.exit(1);
}

if (!fs.existsSync(versionJsonPath)) {
  console.error(
    `elizaOS Electrobun version.json not found: ${versionJsonPath}`,
  );
  process.exit(1);
}

if (!fs.existsSync(brandConfigPath)) {
  console.error(
    `elizaOS Electrobun brand-config.json not found: ${brandConfigPath}`,
  );
  process.exit(1);
}

function patchAgentPackageExports(agentPackageJson) {
  const exportsMap = {
    ...(agentPackageJson.exports ?? {}),
  };
  const proberExport = {
    types: "./dist/packages/agent/src/services/permissions/probers/index.d.ts",
    import: "./dist/packages/agent/src/services/permissions/probers/index.js",
    default: "./dist/packages/agent/src/services/permissions/probers/index.js",
  };
  const proberPatternExport = {
    types: "./dist/packages/agent/src/services/permissions/probers/*.d.ts",
    import: "./dist/packages/agent/src/services/permissions/probers/*.js",
    default: "./dist/packages/agent/src/services/permissions/probers/*.js",
  };

  return {
    ...agentPackageJson,
    exports: {
      ...exportsMap,
      "./services/permissions/probers/index": proberExport,
      "./services/permissions/probers/*": proberPatternExport,
    },
  };
}

function packageDirectory(packageName) {
  return path.join(
    stage,
    "Resources/app/eliza-dist/node_modules",
    ...packageName.split("/"),
  );
}

function packageJsonWrite(packageName, packageJson) {
  return {
    filePath: path.join(packageDirectory(packageName), "package.json"),
    content: `${JSON.stringify(packageJson, null, 2)}\n`,
  };
}

function packageManifestPath(packageName) {
  return path.join(packageDirectory(packageName), "package.json");
}

function readPackageManifest(packageName) {
  const filePath = packageManifestPath(packageName);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isLiveStubPackage(packageJson) {
  return packageJson?.version === "0.0.0-elizaos-live-stub";
}

function shouldWriteLiveFallbackPackage(packageName) {
  const packageJson = readPackageManifest(packageName);
  return (
    forceLiveStubPackages.has(packageName) ||
    !packageJson ||
    isLiveStubPackage(packageJson)
  );
}

function sourcePackageManifest(_packageName, packageJson) {
  if (_packageName === "@elizaos/plugin-elizacloud") {
    return {
      ...sourcePackageManifest("@elizaos/__generic", packageJson),
      private: true,
      main: "./src/index.node.ts",
      module: "./src/index.node.ts",
      types: "./src/index.node.ts",
      exports: {
        ...sourcePackageManifest("@elizaos/__generic", packageJson).exports,
        ".": {
          types: "./src/index.node.ts",
          import: "./src/index.node.ts",
          default: "./src/index.node.ts",
        },
      },
    };
  }

  if (_packageName === "@elizaos/plugin-sql") {
    return {
      ...packageJson,
      private: true,
      main: "./src/index.node.ts",
      module: "./src/index.node.ts",
      types: "./src/index.ts",
      exports: {
        "./package.json": "./package.json",
        ".": {
          types: "./src/index.ts",
          import: "./src/index.node.ts",
          default: "./src/index.node.ts",
        },
        "./drizzle": {
          types: "./src/drizzle/index.ts",
          import: "./src/drizzle/index.ts",
          default: "./src/drizzle/index.ts",
        },
        "./schema": {
          types: "./src/schema/index.ts",
          import: "./src/schema/index.ts",
          default: "./src/schema/index.ts",
        },
        "./*.css": "./dist/*.css",
      },
    };
  }

  const rewrite = (value) => {
    if (typeof value === "string") {
      return value.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts");
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    if (
      value["eliza-source"] &&
      typeof value["eliza-source"] === "object" &&
      !Array.isArray(value["eliza-source"])
    ) {
      const source = value["eliza-source"];
      return {
        ...Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]),
        ),
        types: rewrite(source.types ?? value.types),
        import: rewrite(source.import ?? source.default ?? value.import),
        default: rewrite(source.default ?? source.import ?? value.default),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]),
    );
  };

  return {
    ...packageJson,
    private: true,
    main: "./src/index.ts",
    module: "./src/index.ts",
    types: "./src/index.ts",
    exports: rewrite(packageJson.exports) ?? {
      ".": {
        types: "./src/index.ts",
        import: "./src/index.ts",
        default: "./src/index.ts",
      },
    },
  };
}

function liveAgentOrchestratorWrites() {
  const packageJson = {
    name: "agent-orchestrator",
    version: "0.0.0-elizaos-live",
    private: true,
    type: "module",
    main: "./index.js",
    exports: "./index.js",
  };
  const aliasJson = {
    name: "@elizaos/plugin-agent-orchestrator",
    version: "0.0.0-elizaos-live",
    private: true,
    type: "module",
    main: "./index.js",
    exports: "./index.js",
  };
  return [
    packageJsonWrite("agent-orchestrator", packageJson),
    {
      filePath: path.join(packageDirectory("agent-orchestrator"), "index.js"),
      content: `${liveAgentOrchestratorStub.trimStart()}\n`,
    },
    packageJsonWrite("@elizaos/plugin-agent-orchestrator", aliasJson),
    {
      filePath: path.join(
        packageDirectory("@elizaos/plugin-agent-orchestrator"),
        "index.js",
      ),
      content:
        'export * from "agent-orchestrator";\nexport { default } from "agent-orchestrator";\n',
    },
  ];
}

function sourcePackageManifestWrites() {
  const writes = [];
  for (const packageName of [
    "@elizaos/plugin-app-control",
    "@elizaos/plugin-local-inference",
  ]) {
    const packageJsonPath = path.join(
      packageDirectory(packageName),
      "package.json",
    );
    if (!fs.existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    writes.push(
      packageJsonWrite(
        packageName,
        sourcePackageManifest(packageName, packageJson),
      ),
    );
  }
  return writes;
}

function optionalStubPackageWrites() {
  const writes = [];
  for (const [packageName, source] of optionalStubPackages) {
    if (!shouldWriteLiveFallbackPackage(packageName)) continue;
    const packageDir = packageDirectory(packageName);
    writes.push({
      filePath: path.join(packageDir, "package.json"),
      content: `${JSON.stringify(
        {
          name: packageName,
          version: "0.0.0-elizaos-live-stub",
          private: true,
          type: "module",
          main: "./index.js",
          exports: {
            ".": "./index.js",
            "./plugin": "./plugin.js",
            "./routes/plugin": "./routes/plugin.js",
            "./setup-routes": "./setup-routes.js",
          },
        },
        null,
        2,
      )}\n`,
    });
    writes.push({
      filePath: path.join(packageDir, "index.js"),
      content: source,
    });
    for (const [subpath, indexPath] of [
      ["plugin.js", "./index.js"],
      [path.join("routes", "plugin.js"), "../index.js"],
      ["setup-routes.js", "./index.js"],
    ]) {
      writes.push({
        filePath: path.join(packageDir, subpath),
        content: [
          `export * from "${indexPath}";`,
          `export { default } from "${indexPath}";`,
          "",
        ].join("\n"),
      });
    }
  }
  return writes;
}

function walkFiles(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function workspacePackagePath(relativePath) {
  return workspaceRoot ? path.join(workspaceRoot, relativePath) : null;
}

function syncDirectoryContents(
  sourceDir,
  targetDir,
  { checkOnly, include = () => true },
) {
  let stale = false;
  if (!fs.existsSync(sourceDir)) return false;
  if (!fs.existsSync(targetDir)) {
    stale = true;
  }
  if (!checkOnly) {
    removePathRecursive(targetDir);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => {
        if (sourcePath === sourceDir) return true;
        const relativePath = path.relative(sourceDir, sourcePath);
        return include(relativePath, sourcePath);
      },
    });
    return stale;
  }
  walkFiles(sourceDir, (sourcePath) => {
    const relativePath = path.relative(sourceDir, sourcePath);
    if (!include(relativePath, sourcePath)) return;
    const targetPath = path.join(targetDir, relativePath);
    if (
      !fs.existsSync(targetPath) ||
      fs.readFileSync(sourcePath).compare(fs.readFileSync(targetPath)) !== 0
    ) {
      stale = true;
    }
  });
  walkFiles(targetDir, (targetPath) => {
    const relativePath = path.relative(targetDir, targetPath);
    if (!include(relativePath, targetPath)) return;
    const sourcePath = path.join(sourceDir, relativePath);
    if (!fs.existsSync(sourcePath)) {
      stale = true;
    }
  });
  return stale;
}

const sourceRuntimePackages = [
  ["@elizaos/cloud-sdk", "packages/cloud/sdk"],
  ["@elizaos/plugin-agent-skills", "plugins/plugin-agent-skills"],
  ["@elizaos/plugin-app-control", "plugins/plugin-app-control"],
  ["@elizaos/plugin-browser", "plugins/plugin-browser"],
  ["@elizaos/plugin-coding-tools", "plugins/plugin-coding-tools"],
  ["@elizaos/plugin-commands", "plugins/plugin-commands"],
  ["@elizaos/plugin-computeruse", "plugins/plugin-computeruse"],
  ["@elizaos/plugin-native-filesystem", "plugins/plugin-native-filesystem"],
  ["@elizaos/plugin-elizacloud", "plugins/plugin-elizacloud"],
  ["@elizaos/plugin-sql", "plugins/plugin-sql"],
  ["@elizaos/plugin-video", "plugins/plugin-video"],
  ["@elizaos/plugin-workflow", "plugins/plugin-workflow"],
  ["@elizaos/plugin-remote-manifest", "packages/plugin-remote-manifest"],
  ["@elizaos/plugin-worker-runtime", "packages/plugin-worker-runtime"],
];

function includeRuntimePackageFile(relativePath) {
  const parts = relativePath.split(path.sep);
  if (relativePath === "package.json") return false;
  if (parts.includes("node_modules")) return false;
  if (parts.includes(".turbo")) return false;
  if (parts.includes("coverage")) return false;
  if (parts.includes(".git")) return false;
  return true;
}

function syncSourceRuntimePackage(packageName, relativeSource, { checkOnly }) {
  const packageSource = workspacePackagePath(relativeSource);
  if (!packageSource || !fs.existsSync(packageSource)) return false;

  let stale = false;
  const targetDir = packageDirectory(packageName);
  stale =
    syncDirectoryContents(packageSource, targetDir, {
      checkOnly,
      include: includeRuntimePackageFile,
    }) || stale;

  const sourcePackageJson = path.join(packageSource, "package.json");
  if (fs.existsSync(sourcePackageJson)) {
    const sourceManifest = JSON.parse(
      fs.readFileSync(sourcePackageJson, "utf8"),
    );
    const targetPackageJson = path.join(targetDir, "package.json");
    const targetManifest = `${JSON.stringify(
      sourcePackageManifest(packageName, sourceManifest),
      null,
      2,
    )}\n`;
    if (
      !fs.existsSync(targetPackageJson) ||
      fs.readFileSync(targetPackageJson, "utf8") !== targetManifest
    ) {
      stale = true;
      if (!checkOnly) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(targetPackageJson, targetManifest);
      }
    }
  }

  return stale;
}

function syncWorkspaceRuntimePackages({ checkOnly }) {
  let stale = false;

  for (const [packageName, relativeSource] of sourceRuntimePackages) {
    stale =
      syncSourceRuntimePackage(packageName, relativeSource, { checkOnly }) ||
      stale;
  }

  for (const [packageName, relativeSource] of [
    ["@elizaos/plugin-calendly", "plugins/plugin-calendly"],
    ["@elizaos/plugin-health", "plugins/plugin-health"],
    ["@elizaos/plugin-app-manager", "plugins/plugin-app-manager"],
    ["@elizaos/plugin-registry", "plugins/plugin-registry"],
  ]) {
    const packageSource = workspacePackagePath(relativeSource);
    if (!packageSource || !fs.existsSync(packageSource)) continue;
    const targetDir = packageDirectory(packageName);
    const sourcePackageJson = path.join(packageSource, "package.json");
    const sourceDistDir = path.join(packageSource, "dist");
    if (!fs.existsSync(targetDir)) stale = true;
    if (!checkOnly) fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(sourcePackageJson)) {
      const targetPackageJson = path.join(targetDir, "package.json");
      const sourceContent = fs.readFileSync(sourcePackageJson, "utf8");
      if (
        !fs.existsSync(targetPackageJson) ||
        fs.readFileSync(targetPackageJson, "utf8") !== sourceContent
      ) {
        stale = true;
        if (!checkOnly) fs.writeFileSync(targetPackageJson, sourceContent);
      }
    }
    if (fs.existsSync(sourceDistDir)) {
      stale =
        syncDirectoryContents(sourceDistDir, path.join(targetDir, "dist"), {
          checkOnly,
        }) || stale;
    }
  }

  return stale;
}

function collectLucideReactNames() {
  const names = new Set(["Icon", "LucideIcon", "createLucideIcon"]);
  const appRuntimeDir = path.join(stage, "Resources/app");
  const namedImportRe =
    /\b(?:import|export)\s+(?:type\s+)?\{([^;]*)\}\s+from\s*["']lucide-react["']/g;
  const destructuredImportRe =
    /\b(?:const|let|var)\s+\{([\s\S]*?)\}\s*=\s*(?:await\s+)?(?:import\(["']lucide-react["']\)|require\(["']lucide-react["']\))/g;
  const supportedExts = new Set([".js", ".jsx", ".ts", ".tsx"]);

  function addNamesFromClause(clause) {
    const imports = clause
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .split(",");
    for (const rawName of imports) {
      const cleaned = rawName.trim();
      if (!cleaned) continue;
      const name = cleaned
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  walkFiles(appRuntimeDir, (filePath) => {
    if (!supportedExts.has(path.extname(filePath))) return;
    const text = fs.readFileSync(filePath, "utf8");
    if (!text.includes("lucide-react")) return;
    for (const match of [
      ...text.matchAll(namedImportRe),
      ...text.matchAll(destructuredImportRe),
    ]) {
      addNamesFromClause(match[1]);
    }
  });

  return [...names].sort();
}

function lucideReactStubWrites() {
  if (!shouldWriteLiveFallbackPackage("lucide-react")) return [];
  const packageDir = path.join(
    stage,
    "Resources/app/eliza-dist/node_modules/lucide-react",
  );
  const names = new Set(collectLucideReactNames());
  for (const name of lucideSentinelExports) {
    names.add(name);
  }
  const packageJson = {
    name: "lucide-react",
    version: "0.0.0-elizaos-live-stub",
    private: true,
    type: "module",
    main: "./index.js",
    exports: "./index.js",
  };
  const iconExports = [...names]
    .filter((name) => name !== "Icon" && name !== "createLucideIcon")
    .sort()
    .map((name) => `export const ${name} = Icon;`)
    .join("\n");
  return [
    {
      filePath: path.join(packageDir, "package.json"),
      content: `${JSON.stringify(packageJson, null, 2)}\n`,
    },
    {
      filePath: path.join(packageDir, "index.js"),
      content: [
        "export function Icon() {",
        "  return null;",
        "}",
        "export const createLucideIcon = () => Icon;",
        iconExports,
        "export default Icon;",
        "",
      ].join("\n"),
    },
  ];
}

function liveRuntimeEntryWrites() {
  const entryPath = path.join(stage, "Resources/app/eliza-dist/entry.js");
  const appCoreEntryPath = path.join(
    stage,
    "Resources/app/eliza-dist/node_modules/@elizaos/app-core/dist/entry.js",
  );
  if (!fs.existsSync(entryPath) || !fs.existsSync(appCoreEntryPath)) return [];

  return [
    {
      filePath: entryPath,
      content: [
        "#!/usr/bin/env bun",
        "// auto-generated by prepare-elizaos-app-overlay.mjs",
        "// elizaOS Live must boot from the bundled runtime, not the source checkout.",
        'import "./node_modules/@elizaos/app-core/dist/entry.js";',
        "",
      ].join("\n"),
    },
  ];
}

function agentApiLazyWalletWrites() {
  const filePath = path.join(
    stage,
    "Resources/app/eliza-dist/node_modules/@elizaos/agent/src/api/index.ts",
  );
  if (!fs.existsSync(filePath)) return [];

  const sourcePath = workspacePackagePath("packages/agent/src/api/index.ts");
  const walletExportBlock = [
    "export {",
    "  handleWalletRoutes,",
    "  type WalletAddressesSnapshot,",
    "  type WalletRouteContext,",
    "  type WalletRouteDependencies,",
    "  type WalletRpcReadinessSnapshot,",
    '} from "@elizaos/plugin-wallet";',
  ].join("\n");
  const content =
    sourcePath && fs.existsSync(sourcePath)
      ? fs.readFileSync(sourcePath, "utf8")
      : fs
          .readFileSync(filePath, "utf8")
          .replace(
            walletExportBlock,
            [
              "export type {",
              "  WalletAddressesSnapshot,",
              "  WalletRouteContext,",
              "  WalletRouteDependencies,",
              "  WalletRpcReadinessSnapshot,",
              '} from "@elizaos/plugin-wallet";',
              'export const handleWalletRoutes: typeof import("@elizaos/plugin-wallet").handleWalletRoutes =',
              "  async (context) => {",
              '    const walletApi = await import("@elizaos/plugin-wallet");',
              "    return walletApi.handleWalletRoutes(context);",
              "  };",
            ].join("\n"),
          );

  if (
    !content.includes("export const handleWalletRoutes") ||
    content.includes("  handleWalletRoutes,\n  type WalletAddressesSnapshot")
  ) {
    throw new Error(`${filePath}: failed to apply lazy wallet route import`);
  }

  return [{ filePath, content }];
}

function relativeToStage(filePath) {
  return path.relative(stage, filePath).replaceAll(path.sep, "/");
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

function gitOutput(cwd, args) {
  if (!cwd) return null;
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function buildTimestamp() {
  if (check && existingOverlayManifest?.build?.generatedAt) {
    return existingOverlayManifest.build.generatedAt;
  }
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  return new Date().toISOString();
}

function packageNameFromManifest(filePath, packageJson) {
  if (typeof packageJson?.name === "string" && packageJson.name) {
    return packageJson.name;
  }
  const relative = path.relative(nodeModulesPath, path.dirname(filePath));
  const parts = relative.split(path.sep);
  if (parts[0]?.startsWith("@")) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? relative;
}

function collectPackageInventory(projectedPackages = []) {
  const packages = new Map();
  walkFiles(nodeModulesPath, (filePath) => {
    if (path.basename(filePath) !== "package.json") return;
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return;
    }
    const packageName = packageNameFromManifest(filePath, packageJson);
    const packagePath = relativeToStage(filePath);
    packages.set(packagePath, {
      name: packageName,
      version: packageJson.version ?? null,
      path: packagePath,
      private: packageJson.private === true,
      liveStub: isLiveStubPackage(packageJson),
    });
  });

  for (const projected of projectedPackages) {
    const packagePath = relativeToStage(packageManifestPath(projected.name));
    if (packages.has(packagePath)) continue;
    packages.set(packagePath, {
      name: projected.name,
      version: projected.version,
      path: packagePath,
      private: true,
      liveStub: projected.liveStub === true,
    });
  }

  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  );
}

function packageStatus(packageName) {
  const packageJson = readPackageManifest(packageName);
  const generated =
    forceLiveStubPackages.has(packageName) ||
    !packageJson ||
    isLiveStubPackage(packageJson);
  return {
    packageName,
    packagePath: relativeToStage(packageManifestPath(packageName)),
    indexPath: relativeToStage(
      path.join(packageDirectory(packageName), "index.js"),
    ),
    generated,
    packageVersion: generated
      ? "0.0.0-elizaos-live-stub"
      : (packageJson?.version ?? null),
    stubVersion: "0.0.0-elizaos-live-stub",
  };
}

function generatedRuntimePackages(lucideNames) {
  const packages = [
    {
      packageName: "agent-orchestrator",
      packagePath: relativeToStage(packageManifestPath("agent-orchestrator")),
      indexPath: relativeToStage(
        path.join(packageDirectory("agent-orchestrator"), "index.js"),
      ),
      generated: true,
      version: "0.0.0-elizaos-live",
      reason: "Live capability-broker bridge.",
    },
    {
      packageName: "@elizaos/plugin-agent-orchestrator",
      packagePath: relativeToStage(
        packageManifestPath("@elizaos/plugin-agent-orchestrator"),
      ),
      indexPath: relativeToStage(
        path.join(
          packageDirectory("@elizaos/plugin-agent-orchestrator"),
          "index.js",
        ),
      ),
      generated: true,
      version: "0.0.0-elizaos-live",
      reason: "Package alias for the live capability-broker bridge.",
    },
    ...[...optionalStubPackages.keys()].sort().map((packageName) => ({
      ...packageStatus(packageName),
      reason:
        "Optional desktop connector not required for the live USB base runtime.",
    })),
    {
      ...packageStatus("lucide-react"),
      generatedFrom: "Resources/app named lucide-react import/export sites",
      sentinelExports: lucideSentinelExports,
      exportCount: lucideNames.length,
      reason: "Renderer icon dependency fallback for packaged runtime imports.",
    },
  ];
  return packages;
}

function entrypoint(name, relativePath, installPath, options = {}) {
  const filePath = path.join(stage, relativePath);
  return {
    name,
    stagePath: relativePath,
    installPath,
    type: options.type ?? "file",
    required: options.required !== false,
    executable: options.executable === true,
    existsAtGeneration: fs.existsSync(filePath),
  };
}

function osEntrypoint(name, livePath, sourcePath, options = {}) {
  const filePath = path.join(
    root,
    "tails/config/chroot_local-includes",
    sourcePath,
  );
  return {
    name,
    livePath,
    sourcePath,
    type: options.type ?? "file",
    required: options.required !== false,
    executable: options.executable === true,
    existsAtGeneration: fs.existsSync(filePath),
  };
}

function liveOverlayManifestWrite() {
  const lucideNames = collectLucideReactNames();
  const generatedPackages = generatedRuntimePackages(lucideNames);
  const projectedPackages = generatedPackages
    .filter((pkg) => pkg.generated)
    .map((pkg) => ({
      name: pkg.packageName,
      version: pkg.version ?? pkg.stubVersion,
      liveStub: pkg.stubVersion === "0.0.0-elizaos-live-stub",
    }));
  const packageInventory = collectPackageInventory(projectedPackages);
  const sourceRoot =
    check && existingOverlayManifest?.source?.gitRoot
      ? existingOverlayManifest.source.gitRoot
      : (workspaceRoot ?? gitOutput(root, ["rev-parse", "--show-toplevel"]));
  const sourceCommit =
    check && existingOverlayManifest?.source?.gitCommit
      ? existingOverlayManifest.source.gitCommit
      : gitOutput(sourceRoot, ["rev-parse", "HEAD"]);
  const dirtyStatus =
    check && typeof existingOverlayManifest?.source?.gitDirty === "boolean"
      ? null
      : gitOutput(sourceRoot, ["status", "--short"]);
  const gitDirty =
    check && typeof existingOverlayManifest?.source?.gitDirty === "boolean"
      ? existingOverlayManifest.source.gitDirty
      : dirtyStatus !== null
        ? dirtyStatus.length > 0
        : null;

  return [
    {
      filePath: overlayManifestPath,
      content: `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedBy: "prepare-elizaos-app-overlay.mjs",
          build: {
            generatedAt: buildTimestamp(),
            sourceDateEpoch:
              check &&
              "sourceDateEpoch" in (existingOverlayManifest?.build ?? {})
                ? existingOverlayManifest.build.sourceDateEpoch
                : (process.env.SOURCE_DATE_EPOCH ?? null),
          },
          source: {
            gitRoot: sourceRoot,
            gitCommit: sourceCommit,
            gitDirty,
            distroRoot: root,
          },
          stagePath: {
            default: path.relative(root, defaultStage),
            overrideEnv: "ELIZAOS_APP_STAGE",
            overrideArg: "--stage",
            current: stage,
          },
          app: {
            name: nextVersionInfo.name,
            identifier: nextVersionInfo.identifier,
            appRoot: "/opt/elizaos",
            stagedRoot: stage,
            appRuntimeRoot: "Resources/app",
            rendererRoot: "Resources/app/renderer",
            nodeModulesRoot: relativeToStage(nodeModulesPath),
          },
          packages: {
            packageCount: packageInventory.length,
            packageJsonCount: packageInventory.length,
            inventory: packageInventory,
          },
          generated: {
            packages: generatedPackages,
            optionalPluginStubs: generatedPackages.filter((pkg) =>
              optionalStubPackages.has(pkg.packageName),
            ),
            localPatches: [
              {
                packageName: "@elizaos/plugin-app-control",
                path: relativeToStage(
                  path.join(
                    packageDirectory("@elizaos/plugin-app-control"),
                    "package.json",
                  ),
                ),
                behavior: "package manifest is rewritten to source entrypoints",
              },
              {
                packageName: "@elizaos/plugin-local-inference",
                env: "ELIZAOS_LIVE_EMBEDDING_FALLBACK",
                behavior:
                  "live launcher may enable zero-vector embedding fallback when no local inference backend is active",
              },
              {
                packageName: "@elizaos/core",
                behavior:
                  "test-only exports are stripped from the packaged node entrypoint",
              },
              {
                packageName: "@elizaos/app-core",
                path: "Resources/app/eliza-dist/entry.js",
                behavior:
                  "live runtime entry imports the bundled app-core dist entry instead of source-checkout paths",
              },
            ],
          },
          entrypoints: [
            entrypoint(
              "Electrobun launcher",
              "bin/launcher",
              "/opt/elizaos/bin/launcher",
              {
                executable: true,
              },
            ),
            entrypoint("Bundled Bun", "bin/bun", "/opt/elizaos/bin/bun", {
              executable: true,
            }),
            entrypoint(
              "Agent runtime",
              "Resources/app/eliza-dist/entry.js",
              "/opt/elizaos/Resources/app/eliza-dist/entry.js",
            ),
            entrypoint(
              "Renderer shell",
              "Resources/app/renderer/index.html",
              "/opt/elizaos/Resources/app/renderer/index.html",
            ),
            entrypoint(
              "Build metadata",
              "Resources/build.json",
              "/opt/elizaos/Resources/build.json",
            ),
            entrypoint(
              "Version metadata",
              "Resources/version.json",
              "/opt/elizaos/Resources/version.json",
            ),
            entrypoint(
              "Brand config",
              "Resources/app/brand-config.json",
              "/opt/elizaos/Resources/app/brand-config.json",
            ),
          ],
          osEntrypoints: [
            osEntrypoint(
              "Live app launcher wrapper",
              "/usr/local/bin/elizaos",
              "usr/local/bin/elizaos",
              { executable: true },
            ),
            osEntrypoint(
              "Agent user service launcher",
              "/usr/local/lib/elizaos/start-elizaos-agent-user",
              "usr/local/lib/elizaos/start-elizaos-agent-user",
              { executable: true },
            ),
            osEntrypoint(
              "Renderer user service launcher",
              "/usr/local/lib/elizaos/start-elizaos-renderer-user",
              "usr/local/lib/elizaos/start-elizaos-renderer-user",
              { executable: true },
            ),
            osEntrypoint(
              "Browser user service launcher",
              "/usr/local/lib/elizaos/start-elizaos-browser-user",
              "usr/local/lib/elizaos/start-elizaos-browser-user",
              { executable: true },
            ),
            osEntrypoint(
              "Renderer server",
              "/usr/local/lib/elizaos/renderer-server.mjs",
              "usr/local/lib/elizaos/renderer-server.mjs",
              { executable: true },
            ),
            osEntrypoint(
              "System supervisor unit",
              "/etc/systemd/system/elizaos.service",
              "etc/systemd/system/elizaos.service",
            ),
            osEntrypoint(
              "User browser unit",
              "/etc/systemd/user/elizaos.service",
              "etc/systemd/user/elizaos.service",
            ),
            osEntrypoint(
              "User agent unit",
              "/etc/systemd/user/elizaos-agent.service",
              "etc/systemd/user/elizaos-agent.service",
            ),
            osEntrypoint(
              "User renderer unit",
              "/etc/systemd/user/elizaos-renderer.service",
              "etc/systemd/user/elizaos-renderer.service",
            ),
          ],
          expectedPorts: {
            api: {
              env: "ELIZA_API_PORT",
              bindEnv: "ELIZA_API_BIND",
              defaultPort: 31337,
              defaultBind: "127.0.0.1",
              strictPortEnv: "ELIZA_API_STRICT_PORT",
              strictPortDefault: true,
            },
            renderer: {
              env: "ELIZAOS_RENDERER_PORT",
              defaultPort: 5174,
              defaultBind: "127.0.0.1",
            },
          },
          runtime: {
            apiPortEnv: "ELIZA_API_PORT",
            defaultApiPort: 31337,
            apiBindEnv: "ELIZA_API_BIND",
            defaultApiBind: "127.0.0.1",
            closeMinimizesToTrayEnv: "ELIZAOS_CLOSE_MINIMIZES_TO_TRAY",
            closeMinimizesToTrayDefault: true,
            exitOnLastWindowClosed: false,
            cefProfileCompatEnv: "ELIZAOS_CEF_PROFILE_COMPAT",
            chromiumUserDataDir: chromiumFlags["user-data-dir"],
          },
          fallbacks: {
            optionalPluginStubs: [...optionalStubPackages.keys()].sort(),
            lucideReactStub: {
              generatedFrom:
                "Resources/app named lucide-react import/export sites",
              sentinelExports: lucideSentinelExports,
            },
            localEmbeddingFallback: {
              env: "ELIZAOS_LIVE_EMBEDDING_FALLBACK",
              defaultEnabledInLiveLauncher: true,
            },
          },
          repositoryResolution: {
            expectedOrgName: "elizaOS",
            expectedRepoName: "eliza",
            forbiddenHardCodedNeedles: [
              "github.com/elizaos/elizaos",
              'orgName:"elizaos"',
              'repoName:"eliza"',
              'docsUrl:"https://docs.elizaos.ai"',
              'appUrl:"https://app.elizaos.ai"',
            ],
          },
          validation: {
            script: relativeToRoot(
              path.join(root, "scripts/validate-runtime-overlay.mjs"),
            ),
            cheapCheck:
              "node scripts/validate-runtime-overlay.mjs --stage tails/config/chroot_local-includes/usr/share/elizaos/elizaos-app",
          },
        },
        null,
        2,
      )}\n`,
    },
  ];
}

function patchLocalInferenceFallback(content, kind) {
  if (content.includes("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) return content;

  if (kind === "source") {
    content = content.replace(
      `function requireService(
\truntime: IAgentRuntime,
\tmodelType: string,
): LocalInferenceRuntimeService {
\tconst service = serviceFromRuntime(runtime);
\tif (!service) {
\t\tthrow unavailable(
\t\t\tmodelType,
\t\t\t"backend_unavailable",
\t\t\t\`[local-inference] \${modelType} requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader.\`,
\t\t);
\t}
\treturn service;
}
`,
      `function requireService(
\truntime: IAgentRuntime,
\tmodelType: string,
): LocalInferenceRuntimeService {
\tconst service = serviceFromRuntime(runtime);
\tif (!service) {
\t\tthrow unavailable(
\t\t\tmodelType,
\t\t\t"backend_unavailable",
\t\t\t\`[local-inference] \${modelType} requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader.\`,
\t\t);
\t}
\treturn service;
}

function liveEmbeddingFallbackEnabled(): boolean {
\tconst value = process.env.ELIZAOS_LIVE_EMBEDDING_FALLBACK?.trim().toLowerCase();
\treturn value === "1" || value === "true" || value === "yes";
}

function liveEmbeddingFallbackVector(): number[] {
\tconst raw =
\t\tprocess.env.EMBEDDING_DIMENSION ?? process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "384";
\tconst dimension = Number.parseInt(raw, 10);
\tconst safeDimension =
\t\tNumber.isFinite(dimension) && dimension > 0 && dimension <= 8192
\t\t\t? dimension
\t\t\t: 384;
\treturn Array.from({ length: safeDimension }, () => 0);
}
`,
    );
    // Inject the live-fallback short-circuit right after the function's
    // opening brace. Earlier revisions anchored on the function's ENTIRE
    // leading check sequence, which broke every time the plugin inserted or
    // reordered a check upstream of the disable test (the exact drift that
    // re-reddened the nightly while this pipeline was unreachable). The
    // fallback check is order-independent, so the signature is the only
    // anchor this patch actually needs; `isTruthyEnv` is a module-local
    // helper of embedding-warmup-policy.ts, present in every shape so far.
    const warmupSignature = `export function shouldWarmupLocalEmbeddingModel(): boolean {
`;
    if (content.includes(warmupSignature)) {
      content = content.replace(
        warmupSignature,
        `${warmupSignature}\tif (isTruthyEnv("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) {
\t\treturn false;
\t}
`,
      );
    }
    content = content.replace(
      `\t\tconst service = requireService(runtime, ModelType.TEXT_EMBEDDING);
\t\tif (typeof service.embed !== "function") {
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"capability_unavailable",
\t\t\t\t"[local-inference] Active local backend does not implement TEXT_EMBEDDING",
\t\t\t);
\t\t}
`,
      `\t\tconst service = serviceFromRuntime(runtime);
\t\tif (!service) {
\t\t\tif (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"backend_unavailable",
\t\t\t\t"[local-inference] TEXT_EMBEDDING requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader.",
\t\t\t);
\t\t}
\t\tif (typeof service.embed !== "function") {
\t\t\tif (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"capability_unavailable",
\t\t\t\t"[local-inference] Active local backend does not implement TEXT_EMBEDDING",
\t\t\t);
\t\t}
`,
    );
    content = content.replace(
      `\t\tconst service = serviceFromRuntime(runtime);
\t\tif (!service) {
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"backend_unavailable",
\t\t\t\t"[local-inference] TEXT_EMBEDDING requires an active Eliza-1 backend or another embedding provider; refusing to synthesize zero-vectors.",
\t\t\t);
\t\t}
\t\tif (typeof service.embed !== "function") {
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"capability_unavailable",
\t\t\t\t"[local-inference] Active local backend does not implement TEXT_EMBEDDING",
\t\t\t);
\t\t}
`,
      `\t\tconst service = serviceFromRuntime(runtime);
\t\tif (!service) {
\t\t\tif (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"backend_unavailable",
\t\t\t\t"[local-inference] TEXT_EMBEDDING requires an active Eliza-1 backend or another embedding provider; refusing to synthesize zero-vectors.",
\t\t\t);
\t\t}
\t\tif (typeof service.embed !== "function") {
\t\t\tif (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();
\t\t\tthrow unavailable(
\t\t\t\tModelType.TEXT_EMBEDDING,
\t\t\t\t"capability_unavailable",
\t\t\t\t"[local-inference] Active local backend does not implement TEXT_EMBEDDING",
\t\t\t);
\t\t}
`,
    );
    return content;
  }

  // The remaining shapes are the bundler's compiled output (dist/index.js and
  // dist/runtime/index.js). Local variable names are NOT a usable anchor here:
  // esbuild/Bun.build rename `service` -> `service2` and `ModelType` ->
  // `ModelType2` whenever those identifiers collide across the bundle, and the
  // exact suffix shifts with bundler version and bundle contents. So anchor
  // only on seams the bundler never rewrites — the `requireService` signature
  // and the embedding handler's throw-message string literals — and tolerate
  // the ModelType suffix with a capture group. `dist/index.js` tree-shakes the
  // warmup helper out entirely (index.ts never calls it), so there the
  // embedding-handler fallback is what carries the flag; `dist/runtime/index.js`
  // re-exports the warmup helper and gets both.

  // Live-launcher fallback helpers, injected ahead of `requireService` so they
  // sit at module scope (function declarations hoist, so the embedding handler
  // below resolves them). The signature is bundler-stable; the renamed body is
  // deliberately not part of the anchor.
  const distRequireServiceSignature =
    "function requireService(runtime, modelType) {";
  if (content.includes(distRequireServiceSignature)) {
    content = content.replace(
      distRequireServiceSignature,
      `function liveEmbeddingFallbackEnabled() {
  const value = process.env.ELIZAOS_LIVE_EMBEDDING_FALLBACK?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
function liveEmbeddingFallbackVector() {
  const raw = process.env.EMBEDDING_DIMENSION ?? process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "384";
  const dimension = Number.parseInt(raw, 10);
  const safeDimension = Number.isFinite(dimension) && dimension > 0 && dimension <= 8192 ? dimension : 384;
  return Array.from({ length: safeDimension }, () => 0);
}
${distRequireServiceSignature}`,
    );
  }

  // Warmup short-circuit. Signature-only anchor (order-independent): the leading
  // check sequence drifts, but the signature does not. `isTruthyEnv` is bundled
  // from the same source module as this function, so it is present wherever the
  // function is. Absent from dist/index.js (tree-shaken) -> no-op there.
  const distWarmupSignature = `function shouldWarmupLocalEmbeddingModel() {
`;
  if (content.includes(distWarmupSignature)) {
    content = content.replace(
      distWarmupSignature,
      `${distWarmupSignature}  if (isTruthyEnv("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) {
    return false;
  }
`,
    );
  }

  // Embedding handler: return the fallback vector instead of throwing when no
  // local embedding backend is available and the live launcher opted in. Anchor
  // on the two unique throw-message literals (the bundler never rewrites string
  // contents); the `(ModelType\d*)` capture re-emits whatever alias the bundle
  // chose. Each message occurs exactly once, so the un-flagged String.replace
  // patches only the embedding handler and leaves requireService's own
  // backend_unavailable throw (a different message) untouched.
  content = content.replace(
    /throw unavailable\((ModelType\d*)\.TEXT_EMBEDDING, "backend_unavailable", "\[local-inference\] TEXT_EMBEDDING requires an active Eliza-1 backend or another embedding provider; refusing to synthesize zero-vectors\."\);/,
    'if (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();\n      throw unavailable($1.TEXT_EMBEDDING, "backend_unavailable", "[local-inference] TEXT_EMBEDDING requires an active Eliza-1 backend or another embedding provider; refusing to synthesize zero-vectors.");',
  );
  content = content.replace(
    /throw unavailable\((ModelType\d*)\.TEXT_EMBEDDING, "capability_unavailable", "\[local-inference\] Active local backend does not implement TEXT_EMBEDDING"\);/,
    'if (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();\n      throw unavailable($1.TEXT_EMBEDDING, "capability_unavailable", "[local-inference] Active local backend does not implement TEXT_EMBEDDING");',
  );
  return content;
}

function localInferenceFallbackWrites() {
  const relativeFiles = [
    [
      "Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/src/provider.ts",
      "source",
    ],
    [
      "Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/src/runtime/embedding-warmup-policy.ts",
      "source",
    ],
    [
      "Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/dist/index.js",
      "dist",
    ],
    [
      "Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/dist/runtime/index.js",
      "dist",
    ],
  ];
  return relativeFiles
    .map(([relativePath, kind]) => {
      const filePath = path.join(stage, relativePath);
      if (!fs.existsSync(filePath)) return null;
      const content = patchLocalInferenceFallback(
        fs.readFileSync(filePath, "utf8"),
        kind,
      );
      if (!content.includes("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) {
        throw new Error(
          `${filePath}: local inference embedding fallback patch did not apply`,
        );
      }
      return {
        filePath,
        content,
      };
    })
    .filter(Boolean);
}

function sanitizedCoreRuntimeWrites() {
  const filePath = path.join(
    stage,
    "Resources/app/eliza-dist/node_modules/@elizaos/core/src/index.node.ts",
  );
  if (!fs.existsSync(filePath)) return [];
  const current = fs.readFileSync(filePath, "utf8");
  const content = current.replace(
    /^export \* from "\.\/testing";$/m,
    "// elizaOS Live strips test-only exports from the packaged runtime.",
  );
  return [{ filePath, content }];
}

function patchRendererHtml(content) {
  const liveTheme = `<style id="elizaos-live-theme">
    html,
    body {
      background: #F7F9FF !important;
      color: #06133F !important;
      font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }

    :root {
      --brand-orange: #0B35F1 !important;
      --eliza-orange: #0B35F1 !important;
      --accent: #0B35F1 !important;
      --accent-rgb: 11, 53, 241 !important;
      --accent-foreground: #FFFFFF !important;
      --accent-subtle: #EAF0FF !important;
      --primary: #0B35F1 !important;
      --primary-foreground: #FFFFFF !important;
      --bg: #F7F9FF !important;
      --card: #FFFFFF !important;
      --text: #06133F !important;
      --txt: #06133F !important;
      --muted: #3550B8 !important;
      --border: #D8E1FF !important;
      color-scheme: light !important;
    }

    [data-testid="onboarding-ui-overlay"] {
      background: linear-gradient(135deg, #FFFFFF 0%, #F7F9FF 56%, #E9EEFF 100%) !important;
      color: #0B35F1 !important;
      font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }

    [data-testid="onboarding-ui-overlay"]::before {
      content: "" !important;
      position: fixed !important;
      inset: 0 !important;
      pointer-events: none !important;
      background:
        radial-gradient(circle at 84% 12%, rgba(11, 53, 241, 0.10), transparent 34%),
        linear-gradient(170deg, transparent 0 70%, rgba(201, 214, 255, 0.26) 70% 100%) !important;
      z-index: 0 !important;
    }

    [data-testid="onboarding-ui-overlay"] * {
      font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      text-shadow: none !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="radial-gradient"] {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0), rgba(11, 53, 241, 0.04)) !important;
    }

    [data-testid="onboarding-ui-overlay"] [style*="polygon"] {
      clip-path: none !important;
      border-radius: 22px !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="bg-black"],
    [data-testid="onboarding-ui-overlay"] [class*="bg-[#0a0805]"],
    [data-testid="onboarding-ui-overlay"] [class*="bg-[#1a1108]"] {
      background: rgba(255, 255, 255, 0.86) !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="border-black"],
    [data-testid="onboarding-ui-overlay"] [class*="border-[#f0b90b]"] {
      border-color: rgba(11, 53, 241, 0.22) !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="text-[#ffe600]"],
    [data-testid="onboarding-ui-overlay"] [class*="text-[#ffe88a]"],
    [data-testid="onboarding-ui-overlay"] [class*="text-[#fff0a3]"] {
      color: #0B35F1 !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="text-white"] {
      color: #0B35F1 !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="placeholder:text-white"]::placeholder {
      color: rgba(11, 53, 241, 0.44) !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="bg-[#ffe600]"],
    [data-testid="onboarding-ui-overlay"] [class*="bg-[#fff0a3]"] {
      background: #0B35F1 !important;
      color: #FFFFFF !important;
      border-color: #0B35F1 !important;
      box-shadow: 0 18px 48px rgba(11, 53, 241, 0.20) !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="shadow-"] {
      box-shadow: 0 24px 72px rgba(11, 53, 241, 0.12) !important;
    }

    [data-testid="onboarding-ui-overlay"] [class*="ring-offset-black"] {
      --tw-ring-offset-color: #F7F9FF !important;
    }

    [data-testid="voice-prefix-gate"],
    [data-testid="voice-prefix-gate"] > div,
    [data-testid="voice-prefix-steps"],
    [data-testid="voice-prefix-steps"] main {
      background: #FFFFFF !important;
      color: #06133F !important;
      border-color: #D8E1FF !important;
      text-shadow: none !important;
    }

    [data-testid="voice-prefix-gate"] {
      background: #F7F9FF !important;
    }

    [data-testid="voice-prefix-gate"] > div,
    [data-testid="voice-prefix-steps"] main {
      box-shadow: 0 24px 80px rgba(11, 53, 241, 0.14) !important;
    }

    [data-testid="voice-prefix-steps"] p,
    [data-testid="voice-prefix-steps"] header,
    [data-testid="voice-prefix-steps"] label {
      color: #3550B8 !important;
    }

    [data-testid="voice-prefix-step-name"],
    [data-testid="voice-prefix-steps"] strong,
    [data-testid="voice-prefix-steps"] input {
      color: #06133F !important;
    }

    [data-testid="voice-prefix-steps"] button {
      border-color: #0B35F1 !important;
      background: #FFFFFF !important;
      color: #0B35F1 !important;
      box-shadow: none !important;
    }

    [data-testid="voice-prefix-continue"],
    [data-testid="voice-prefix-welcome-request-mic"],
    [data-testid="voice-prefix-agent-speaks-play"],
    [data-testid="voice-prefix-user-speaks-record"],
    [data-testid="voice-prefix-owner-confirm-save"],
    [data-testid="voice-prefix-family-record"] {
      background: #0B35F1 !important;
      color: #FFFFFF !important;
      box-shadow: 0 12px 28px rgba(11, 53, 241, 0.22) !important;
    }

    [data-testid="voice-prefix-welcome"] span,
    [data-testid="voice-prefix-family-recording"] {
      background: #EAF0FF !important;
      color: #0B35F1 !important;
      border-color: #C9D6FF !important;
    }
  </style>`;

  let patched = content
    .replaceAll("<title>elizaOS</title>", "<title>elizaOS</title>")
    .replaceAll("<title>Eliza</title>", "<title>elizaOS</title>")
    .replaceAll('content="elizaOS"', 'content="elizaOS"')
    .replaceAll('content="black-translucent"', 'content="default"')
    .replaceAll('content="#08080a"', 'content="#F7F9FF"')
    .replaceAll('content="#FF5800"', 'content="#F7F9FF"')
    .replaceAll('content="#ff5800"', 'content="#F7F9FF"')
    .replaceAll("background-color: #08080a;", "background-color: #F7F9FF;")
    .replaceAll(
      "background-color: var(--bg, #000000);",
      "background-color: var(--bg, #F7F9FF);",
    )
    .replaceAll("color: var(--text, #e8e8ec);", "color: var(--text, #0B35F1);")
    .replaceAll(
      "orange #FF5800. The dark chat shell takes over once React mounts.",
      "elizaOS blue on a soft white shell. The live theme takes over once React mounts.",
    )
    .replaceAll(
      "Painting orange here would strobe into dark; painting pure black",
      "Painting the same soft white here avoids a flash; it",
    )
    .replaceAll(
      "matches the chat shell and is a cleaner handoff. --bg is set by",
      "matches the elizaOS shell and is a cleaner handoff. --bg is set by",
    )
    .replaceAll(
      "Cute agents for the acceleration",
      "AI agents for elizaOS Live",
    )
    .replaceAll("https://app.elizaos.ai/", "https://elizaos.ai/")
    .replaceAll("https://app.elizaos.ai/og-image.png", "https://elizaos.ai/");

  patched = patched.replace(
    /<style id="elizaos-live-theme">[\s\S]*?<\/style>/,
    liveTheme,
  );
  if (!patched.includes('id="elizaos-live-theme"')) {
    patched = patched.replace("</head>", `  ${liveTheme}\n</head>`);
  }

  return patched;
}

function patchRendererManifest(content) {
  const manifest = JSON.parse(content);
  return `${JSON.stringify(
    {
      ...manifest,
      name: "elizaOS",
      short_name: "elizaOS",
      theme_color: "#F7F9FF",
      background_color: "#F7F9FF",
    },
    null,
    2,
  )}\n`;
}

function patchRendererBundle(content) {
  return content
    .replaceAll("#FF5800", "#0B35F1")
    .replaceAll("#ff5800", "#0B35F1")
    .replaceAll("#ff8a24", "#0B35F1")
    .replaceAll("#ffe600", "#0B35F1")
    .replaceAll("#f0b90b", "#D8E1FF")
    .replaceAll("#fff0a3", "#EAF0FF")
    .replaceAll("#e54f00", "#082BC7")
    .replaceAll("#c94400", "#082BC7")
    .replaceAll("#ff6d1f", "#3550B8")
    .replaceAll("255, 88, 0", "11, 53, 241")
    .replaceAll("255,88,0", "11,53,241")
    .replaceAll("WELCOME TO ELIZAOS", "WELCOME TO ELIZAOS")
    .replaceAll("Welcome to elizaOS", "Welcome to elizaOS")
    .replaceAll("elizaOS's HTTP API", "elizaOS HTTP API")
    .replaceAll('appName:"elizaOS"', 'appName:"elizaOS"')
    .replaceAll('orgName:"elizaos"', 'orgName:"elizaOS"')
    .replaceAll('repoName:"eliza"', 'repoName:"eliza"')
    .replaceAll('cliName:"elizaos"', 'cliName:"elizaos"')
    .replaceAll('envPrefix:"ELIZAOS"', 'envPrefix:"ELIZAOS"')
    .replaceAll('namespace:"elizaos"', 'namespace:"eliza"')
    .replaceAll('urlScheme:"elizaos"', 'urlScheme:"elizaos"')
    .replaceAll(
      'docsUrl:"https://docs.elizaos.ai"',
      'docsUrl:"https://docs.elizaos.ai"',
    )
    .replaceAll(
      'appUrl:"https://app.elizaos.ai"',
      'appUrl:"https://elizaos.ai"',
    )
    .replaceAll(
      'bugReportUrl:"https://github.com/elizaos/elizaos/issues/new?template=bug_report.yml"',
      'bugReportUrl:"https://github.com/elizaOS/eliza/issues/new"',
    )
    .replaceAll('hashtag:"#elizaOSAgent"', 'hashtag:"#elizaOS"')
    .replaceAll(
      'fileExtension:".elizaos-agent"',
      'fileExtension:".eliza-agent"',
    )
    .replaceAll('packageScope:"elizaos"', 'packageScope:"elizaos"')
    .replaceAll("elizaos.ai", "elizaOS");
}

function patchRendererSvg(content) {
  return content
    .replaceAll("#FF5800", "#0B35F1")
    .replaceAll("#ff5800", "#0B35F1")
    .replaceAll("#FF0000", "#0B35F1")
    .replaceAll("#ff0000", "#0B35F1")
    .replaceAll("#ff8a24", "#0B35F1")
    .replaceAll("#ffe600", "#0B35F1")
    .replaceAll("#f0b90b", "#0B35F1");
}

function officialLogoWrites() {
  if (!fs.existsSync(rendererRoot)) return [];

  const mappings = [
    ["logo_white_bluebg.svg", "brand/logos/logo_white_bluebg.svg"],
    ["logo_white_bluebg.svg", "brand/logos/logo_white_orangebg.svg"],
    ["logo_blue_nobg.svg", "brand/logos/logo_blue_nobg.svg"],
    ["logo_blue_nobg.svg", "brand/logos/logo_orange_nobg.svg"],
    ["logo_white_nobg.svg", "brand/logos/logo_white_nobg.svg"],
    ["logo_white_bluebg.svg", "brand/logos/logo_orange_blackbg.svg"],
    ["elizaOS_text_black.svg", "brand/logos/elizaOS_text_black.svg"],
    ["elizaOS_text_white.svg", "brand/logos/elizaOS_text_white.svg"],
    ["elizaos_logotext.svg", "brand/logos/elizaos_logotext.svg"],
    ["elizaos_logotext_black.svg", "brand/logos/elizaos_logotext_black.svg"],
  ];

  const writes = [];
  for (const [sourceName, targetRelativePath] of mappings) {
    const sourcePath = path.join(officialAssetRoot, sourceName);
    if (!fs.existsSync(sourcePath)) continue;
    writes.push({
      filePath: path.join(rendererRoot, targetRelativePath),
      content: patchRendererSvg(fs.readFileSync(sourcePath, "utf8")),
    });
  }
  return writes;
}

function rendererBrandingWrites() {
  if (!fs.existsSync(rendererRoot)) return [];
  const writes = [];
  const indexPath = path.join(rendererRoot, "index.html");
  const manifestPath = path.join(rendererRoot, "site.webmanifest");

  if (fs.existsSync(indexPath)) {
    writes.push({
      filePath: indexPath,
      content: patchRendererHtml(fs.readFileSync(indexPath, "utf8")),
    });
  }

  if (fs.existsSync(manifestPath)) {
    writes.push({
      filePath: manifestPath,
      content: patchRendererManifest(fs.readFileSync(manifestPath, "utf8")),
    });
  }

  walkFiles(path.join(rendererRoot, "assets"), (filePath) => {
    if (![".css", ".js"].includes(path.extname(filePath))) return;
    const current = fs.readFileSync(filePath, "utf8");
    const content = patchRendererBundle(current);
    if (content !== current) {
      writes.push({ filePath, content });
    }
  });

  walkFiles(path.join(rendererRoot, "brand"), (filePath) => {
    if (path.extname(filePath) !== ".svg") return;
    const current = fs.readFileSync(filePath, "utf8");
    const content = patchRendererSvg(current);
    if (content !== current) {
      writes.push({ filePath, content });
    }
  });

  return [...writes, ...officialLogoWrites()];
}

function buffersEqual(leftPath, rightPath) {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const left = fs.readFileSync(leftPath);
  const right = fs.readFileSync(rightPath);
  return left.length === right.length && left.compare(right) === 0;
}

function rendererWallpaperTargets() {
  if (!fs.existsSync(rendererRoot) || !fs.existsSync(rendererWallpaperPath)) {
    return [];
  }
  return ["splash-bg.png", "splash-bg-dark.png", "og-image.png"].map((name) =>
    path.join(rendererRoot, name),
  );
}

function fileNeedsWrite({ filePath, content }) {
  try {
    return fs.readFileSync(filePath, "utf8") !== content;
  } catch {
    return true;
  }
}

const buildInfo = JSON.parse(fs.readFileSync(buildJsonPath, "utf8"));
const nextBuildInfo = {
  ...buildInfo,
  defaultRenderer: "native",
  availableRenderers: ["native"],
  runtime: {
    ...(buildInfo.runtime ?? {}),
    exitOnLastWindowClosed: false,
    closeMinimizesToTray: true,
  },
  chromiumFlags,
};

const before = JSON.stringify(buildInfo);
const after = JSON.stringify(nextBuildInfo);

const versionInfo = JSON.parse(fs.readFileSync(versionJsonPath, "utf8"));
const nextVersionInfo = {
  ...versionInfo,
  name: "elizaOS",
  identifier: "org.elizaos.app",
};
const versionBefore = JSON.stringify(versionInfo);
const versionAfter = JSON.stringify(nextVersionInfo);

const brandConfig = JSON.parse(fs.readFileSync(brandConfigPath, "utf8"));
const nextBrandConfig = {
  ...brandConfig,
  ...liveBrandConfig,
};
const brandBefore = JSON.stringify(brandConfig);
const brandAfter = JSON.stringify(nextBrandConfig);

const infoPlist = fs.existsSync(infoPlistPath)
  ? fs.readFileSync(infoPlistPath, "utf8")
  : "";
const nextInfoPlist = infoPlist
  .replaceAll("org.elizaos.app", "org.elizaos.app")
  .replaceAll("elizaOS-dev", "elizaOS")
  .replaceAll("<string>elizaos</string>", "<string>elizaos</string>");

const hasNodeModules = fs.existsSync(nodeModulesPath);
const hasAgentPackage = fs.existsSync(agentPackageJsonPath);
const agentPackageJson = hasAgentPackage
  ? JSON.parse(fs.readFileSync(agentPackageJsonPath, "utf8"))
  : null;
const nextAgentPackageJson = agentPackageJson
  ? patchAgentPackageExports(agentPackageJson)
  : null;
const agentBefore = agentPackageJson ? JSON.stringify(agentPackageJson) : "";
const agentAfter = nextAgentPackageJson
  ? JSON.stringify(nextAgentPackageJson)
  : "";
const missingDependencyLinks = dependencyTargets.filter(
  ({ linkPath, target }) => {
    try {
      return fs.readlinkSync(linkPath) !== target;
    } catch {
      return true;
    }
  },
);
const workspacePackagesStale = syncWorkspaceRuntimePackages({
  checkOnly: check,
});
// Runtime patch writes that mutate node_modules package.json files (and similar
// inputs to the overlay manifest's package inventory). These must be applied
// before computing the overlay manifest content in stage mode so the inventory
// reflects the final on-disk state; otherwise a fresh stage run produces an
// inventory snapshot of pre-rewrite content (e.g. `private: false` for
// @elizaos/plugin-app-control before sourcePackageManifestWrites flips it to
// `private: true`), which then diverges from what `--check` sees on disk.
const preManifestRuntimeWrites = hasNodeModules
  ? [
      ...liveAgentOrchestratorWrites(),
      ...optionalStubPackageWrites(),
      ...sourcePackageManifestWrites(),
      ...lucideReactStubWrites(),
      ...localInferenceFallbackWrites(),
      ...sanitizedCoreRuntimeWrites(),
      ...liveRuntimeEntryWrites(),
      ...agentApiLazyWalletWrites(),
    ]
  : [];
const rendererWrites = rendererBrandingWrites();
const stalePreManifestRuntimeWrites =
  preManifestRuntimeWrites.filter(fileNeedsWrite);
const staleRendererWrites = rendererWrites.filter(fileNeedsWrite);
const staleRendererWallpaperTargets = rendererWallpaperTargets().filter(
  (target) => !buffersEqual(rendererWallpaperPath, target),
);
const chromeSandboxPath = path.join(stage, "bin/chrome-sandbox");
const chromeSandboxMode = fs.existsSync(chromeSandboxPath)
  ? fs.statSync(chromeSandboxPath).mode & 0o7777
  : null;
const chromeSandboxModeStale =
  chromeSandboxMode !== null && chromeSandboxMode !== 0o755;

if (check) {
  // In check mode, all pre-manifest patches have already been applied by a
  // prior stage run (otherwise they would surface as stale here). The on-disk
  // tree therefore matches the "post-patch" view that the manifest content
  // was computed against, so collecting the manifest write now lines up with
  // what stage wrote.
  const overlayManifestWrites = hasNodeModules
    ? liveOverlayManifestWrite()
    : [];
  const staleOverlayManifestWrites =
    overlayManifestWrites.filter(fileNeedsWrite);

  const staleReasons = [];
  if (before !== after) staleReasons.push("Resources/build.json");
  if (versionBefore !== versionAfter)
    staleReasons.push("Resources/version.json");
  if (brandBefore !== brandAfter)
    staleReasons.push("Resources/app/brand-config.json");
  if (infoPlist !== nextInfoPlist) staleReasons.push("Info.plist");
  if (agentBefore !== agentAfter) {
    staleReasons.push(
      "Resources/app/eliza-dist/node_modules/@elizaos/agent/package.json",
    );
  }
  for (const { linkPath } of missingDependencyLinks) {
    staleReasons.push(path.relative(stage, linkPath));
  }
  if (workspacePackagesStale) staleReasons.push("workspace runtime packages");
  for (const { filePath } of stalePreManifestRuntimeWrites) {
    staleReasons.push(path.relative(stage, filePath));
  }
  for (const { filePath } of staleRendererWrites) {
    staleReasons.push(path.relative(stage, filePath));
  }
  for (const { filePath } of staleOverlayManifestWrites) {
    staleReasons.push(path.relative(stage, filePath));
  }
  for (const filePath of staleRendererWallpaperTargets) {
    staleReasons.push(path.relative(stage, filePath));
  }
  if (chromeSandboxModeStale) staleReasons.push("bin/chrome-sandbox mode");

  if (staleReasons.length > 0) {
    console.error(`${buildJsonPath} is not prepared for elizaOS Live`);
    for (const reason of staleReasons) {
      console.error(`  stale: ${reason}`);
    }
    process.exit(1);
  }
  console.log("elizaOS app overlay already prepared for elizaOS Live");
  process.exit(0);
}

fs.writeFileSync(buildJsonPath, `${after}\n`);
fs.writeFileSync(versionJsonPath, `${versionAfter}\n`);
fs.writeFileSync(
  brandConfigPath,
  `${JSON.stringify(nextBrandConfig, null, "\t")}\n`,
);
if (infoPlist && infoPlist !== nextInfoPlist) {
  fs.writeFileSync(infoPlistPath, nextInfoPlist);
}
if (nextAgentPackageJson) {
  fs.writeFileSync(agentPackageJsonPath, `${agentAfter}\n`);
}
for (const { linkPath, target } of dependencyTargets) {
  removePathRecursive(linkPath);
  fs.symlinkSync(target, linkPath);
}
// Apply all package and renderer patches BEFORE computing the overlay manifest
// so that collectPackageInventory() and collectLucideReactNames() observe the
// final on-disk state. This keeps stage's manifest byte-identical to what a
// subsequent --check run would compute from the same tree.
for (const { filePath, content } of preManifestRuntimeWrites) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
for (const { filePath, content } of rendererWrites) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
for (const target of staleRendererWallpaperTargets) {
  fs.copyFileSync(rendererWallpaperPath, target);
}
if (chromeSandboxModeStale) {
  fs.chmodSync(chromeSandboxPath, 0o755);
}
if (hasNodeModules) {
  for (const { filePath, content } of liveOverlayManifestWrite()) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}
console.log(`Prepared elizaOS app overlay for elizaOS Live: ${buildJsonPath}`);

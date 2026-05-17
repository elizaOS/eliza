#!/usr/bin/env node

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
  "tails/config/chroot_local-includes/usr/share/elizaos/milady-app",
);
const stage =
  stageArg ?? process.env.ELIZAOS_MILADY_APP_STAGE ?? defaultStage;
const buildJsonPath = path.join(stage, "Resources/build.json");
const versionJsonPath = path.join(stage, "Resources/version.json");
const infoPlistPath = path.join(stage, "Info.plist");
const brandConfigPath = path.join(stage, "Resources/app/brand-config.json");
const overlayManifestPath = path.join(
  stage,
  "Resources/app/elizaos-live-overlay-manifest.json",
);
const rendererRoot = path.join(stage, "Resources/app/renderer");
const rendererWallpaperPath = path.join(
  root,
  "tails/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png",
);
const agentPackageJsonPath = path.join(
  stage,
  "Resources/app/eliza-dist/node_modules/@elizaos/agent/package.json",
);
const nodeModulesPath = path.join(stage, "Resources/app/eliza-dist/node_modules");
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
    if (fs.existsSync(path.join(current, "plugins/plugin-health/package.json"))) {
      return current;
    }
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot();

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
    "@elizaos/plugin-whatsapp": `
const noop = () => undefined;
const falseRoute = async () => false;

export const WHATSAPP_MAX_PAIRING_SESSIONS = 0;
export const applyWhatsAppQrOverride = noop;
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
  description: "Google connector placeholder for elizaOS Live. OAuth setup can install the full connector package.",
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
    "@elizaos/plugin-mlx": `
export default undefined;
`,
  }).map(([packageName, source]) => [packageName, `${source.trimStart()}\n`]),
);

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
  "user-data-dir": "/home/amnesia/.cache/ai.elizaos.app/dev/CEF/partitions",
};

const liveBrandConfig = {
  appName: "elizaOS",
  appId: "ai.elizaos.app",
  namespace: "eliza",
  urlScheme: "elizaos",
  configDirName: "elizaOS",
  appDescription: "AI agents for elizaOS Live",
  buildVariant: "direct",
  configExportFileName: "eliza-config.json",
  startupLogFileName: "eliza-startup.log",
  linuxDesktopFileName: "milady.desktop",
  linuxDesktopEntryName: "elizaOS",
  cefVersionMarkerFileName: ".eliza-version",
  runtimeDistDirName: "eliza-dist",
  browserWorkspacePartition: "persist:eliza-browser",
  releaseNotesPartition: "persist:eliza-release-notes",
  cefDesktopPartition: "persist:eliza-desktop-cef",
  trustedCloseMessageType: "eliza.trusted-eliza-window.close",
};

if (!fs.existsSync(buildJsonPath)) {
  console.error(`Milady Electrobun build.json not found: ${buildJsonPath}`);
  process.exit(1);
}

if (!fs.existsSync(versionJsonPath)) {
  console.error(`Milady Electrobun version.json not found: ${versionJsonPath}`);
  process.exit(1);
}

if (!fs.existsSync(brandConfigPath)) {
  console.error(`Milady Electrobun brand-config.json not found: ${brandConfigPath}`);
  process.exit(1);
}

function patchAgentPackageExports(agentPackageJson) {
  const exportsMap = {
    ...(agentPackageJson.exports ?? {}),
  };
  const proberExport = {
    types:
      "./dist/packages/agent/src/services/permissions/probers/index.d.ts",
    import:
      "./dist/packages/agent/src/services/permissions/probers/index.js",
    default:
      "./dist/packages/agent/src/services/permissions/probers/index.js",
  };
  const proberPatternExport = {
    types:
      "./dist/packages/agent/src/services/permissions/probers/*.d.ts",
    import:
      "./dist/packages/agent/src/services/permissions/probers/*.js",
    default:
      "./dist/packages/agent/src/services/permissions/probers/*.js",
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
  return !packageJson || isLiveStubPackage(packageJson);
}

function sourcePackageManifest(packageName, packageJson) {
  const rewrite = (value) => {
    if (typeof value === "string") {
      return value.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts");
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
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
  const packageName = "@elizaos/plugin-app-control";
  const packageJsonPath = path.join(packageDirectory(packageName), "package.json");
  if (!fs.existsSync(packageJsonPath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return [packageJsonWrite(packageName, sourcePackageManifest(packageName, packageJson))];
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
          exports: "./index.js",
        },
        null,
        2,
      )}\n`,
    });
    writes.push({
      filePath: path.join(packageDir, "index.js"),
      content: source,
    });
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

function syncDirectoryContents(sourceDir, targetDir, { checkOnly }) {
  let stale = false;
  if (!fs.existsSync(sourceDir)) return false;
  if (!fs.existsSync(targetDir)) {
    stale = true;
  }
  if (!checkOnly) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    return stale;
  }
  walkFiles(sourceDir, (sourcePath) => {
    const relativePath = path.relative(sourceDir, sourcePath);
    const targetPath = path.join(targetDir, relativePath);
    if (
      !fs.existsSync(targetPath) ||
      fs.readFileSync(sourcePath).compare(fs.readFileSync(targetPath)) !== 0
    ) {
      stale = true;
    }
  });
  return stale;
}

function syncWorkspaceRuntimePackages({ checkOnly }) {
  let stale = false;

  const appControlSource = workspacePackagePath("plugins/plugin-app-control");
  if (appControlSource && fs.existsSync(appControlSource)) {
    const targetDir = packageDirectory("@elizaos/plugin-app-control");
    const sourcePackageJson = path.join(appControlSource, "package.json");
    const sourceSrcDir = path.join(appControlSource, "src");
    if (!fs.existsSync(targetDir)) stale = true;
    if (!checkOnly) fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(sourcePackageJson)) {
      const targetPackageJson = path.join(targetDir, "package.json");
      if (!fs.existsSync(targetPackageJson)) {
        stale = true;
        if (!checkOnly) {
          fs.writeFileSync(
            targetPackageJson,
            fs.readFileSync(sourcePackageJson, "utf8"),
          );
        }
      }
    }
    if (fs.existsSync(sourceSrcDir)) {
      stale =
        syncDirectoryContents(sourceSrcDir, path.join(targetDir, "src"), {
          checkOnly,
        }) || stale;
    }
  }

  for (const [packageName, relativeSource] of [
    ["@elizaos/plugin-calendly", "plugins/plugin-calendly"],
    ["@elizaos/plugin-health", "plugins/plugin-health"],
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
  for (const name of ["Feather", "Loader2", "Maximize2", "Settings"]) {
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

function liveOverlayManifestWrite() {
  return [
    {
      filePath: overlayManifestPath,
      content: `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedBy: "prepare-milady-app-overlay.mjs",
          stagePath: {
            default: path.relative(root, defaultStage),
            overrideEnv: "ELIZAOS_MILADY_APP_STAGE",
            overrideArg: "--stage",
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
              generatedFrom: "Resources/app named lucide-react import/export sites",
              sentinelExports: ["Feather", "Loader2", "Settings"],
            },
            localEmbeddingFallback: {
              env: "ELIZAOS_LIVE_EMBEDDING_FALLBACK",
              defaultEnabledInLiveLauncher: true,
            },
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
    content = content.replace(
      `export function shouldWarmupLocalEmbeddingModel(): boolean {
\tif (isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) {
\t\treturn false;
\t}
`,
      `export function shouldWarmupLocalEmbeddingModel(): boolean {
\tif (isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) {
\t\treturn false;
\t}
\tif (isTruthyEnv("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) {
\t\treturn false;
\t}
`,
    );
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
    return content;
  }

  content = content.replace(
    `function requireService(runtime, modelType) {
  const service = serviceFromRuntime(runtime);
  if (!service) {
    throw unavailable(
      modelType,
      "backend_unavailable",
      \`[local-inference] \${modelType} requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader.\`
    );
  }
  return service;
}
`,
    `function requireService(runtime, modelType) {
  const service = serviceFromRuntime(runtime);
  if (!service) {
    throw unavailable(
      modelType,
      "backend_unavailable",
      \`[local-inference] \${modelType} requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader.\`
    );
  }
  return service;
}
function liveEmbeddingFallbackEnabled() {
  const value = process.env.ELIZAOS_LIVE_EMBEDDING_FALLBACK?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
function liveEmbeddingFallbackVector() {
  const raw = process.env.EMBEDDING_DIMENSION ?? process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "384";
  const dimension = Number.parseInt(raw, 10);
  const safeDimension = Number.isFinite(dimension) && dimension > 0 && dimension <= 8192 ? dimension : 384;
  return Array.from({ length: safeDimension }, () => 0);
}
`,
  );
  content = content.replace(
    `function shouldWarmupLocalEmbeddingModel() {
  if (isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) {
    return false;
  }
`,
    `function shouldWarmupLocalEmbeddingModel() {
  if (isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) {
    return false;
  }
  if (isTruthyEnv("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) {
    return false;
  }
`,
  );
  content = content.replace(
    `    const service = requireService(runtime, ModelType.TEXT_EMBEDDING);
    if (typeof service.embed !== "function") {
      throw unavailable(
        ModelType.TEXT_EMBEDDING,
        "capability_unavailable",
        "[local-inference] Active local backend does not implement TEXT_EMBEDDING"
      );
    }
`,
    `    const service = serviceFromRuntime(runtime);
    if (!service) {
      if (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();
      throw unavailable(
        ModelType.TEXT_EMBEDDING,
        "backend_unavailable",
        "[local-inference] TEXT_EMBEDDING requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader."
      );
    }
    if (typeof service.embed !== "function") {
      if (liveEmbeddingFallbackEnabled()) return liveEmbeddingFallbackVector();
      throw unavailable(
        ModelType.TEXT_EMBEDDING,
        "capability_unavailable",
        "[local-inference] Active local backend does not implement TEXT_EMBEDDING"
      );
    }
`,
  );
  return content;
}

function localInferenceFallbackWrites() {
  const relativeFiles = [
    ["Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/src/provider.ts", "source"],
    [
      "Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/src/runtime/embedding-warmup-policy.ts",
      "source",
    ],
    ["Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/dist/index.js", "dist"],
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
      color: #0B35F1 !important;
      font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
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
  </style>`;

  let patched = content
    .replaceAll("<title>Milady</title>", "<title>elizaOS</title>")
    .replaceAll('content="Milady"', 'content="elizaOS"')
    .replaceAll('content="black-translucent"', 'content="default"')
    .replaceAll('content="#08080a"', 'content="#F7F9FF"')
    .replaceAll("background-color: #08080a;", "background-color: #F7F9FF;")
    .replaceAll(
      "Cute agents for the acceleration",
      "AI agents for elizaOS Live",
    )
    .replaceAll("https://app.milady.ai/", "https://elizaos.ai/")
    .replaceAll("https://app.milady.ai/og-image.png", "https://elizaos.ai/");

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
    .replaceAll("WELCOME TO MILADY", "WELCOME TO ELIZAOS")
    .replaceAll("Welcome to Milady", "Welcome to elizaOS")
    .replaceAll("Milady's HTTP API", "elizaOS HTTP API")
    .replaceAll('appName:"Milady"', 'appName:"elizaOS"')
    .replaceAll('orgName:"milady-ai"', 'orgName:"elizaOS"')
    .replaceAll('repoName:"milady"', 'repoName:"eliza"')
    .replaceAll('cliName:"milady"', 'cliName:"elizaos"')
    .replaceAll('envPrefix:"MILADY"', 'envPrefix:"ELIZAOS"')
    .replaceAll('namespace:"milady"', 'namespace:"eliza"')
    .replaceAll('urlScheme:"milady"', 'urlScheme:"elizaos"')
    .replaceAll('docsUrl:"https://docs.milady.ai"', 'docsUrl:"https://docs.elizaos.ai"')
    .replaceAll('appUrl:"https://app.milady.ai"', 'appUrl:"https://elizaos.ai"')
    .replaceAll(
      'bugReportUrl:"https://github.com/milady-ai/milady/issues/new?template=bug_report.yml"',
      'bugReportUrl:"https://github.com/elizaOS/eliza/issues/new"',
    )
    .replaceAll('hashtag:"#MiladyAgent"', 'hashtag:"#elizaOS"')
    .replaceAll('fileExtension:".milady-agent"', 'fileExtension:".eliza-agent"')
    .replaceAll('packageScope:"miladyai"', 'packageScope:"elizaos"')
    .replaceAll("milady.zone", "elizaOS");
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
    if (path.extname(filePath) !== ".js") return;
    const current = fs.readFileSync(filePath, "utf8");
    const content = patchRendererBundle(current);
    if (content !== current) {
      writes.push({ filePath, content });
    }
  });

  return writes;
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
  identifier: "ai.elizaos.app",
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
  .replaceAll("ai.milady.milady", "ai.elizaos.app")
  .replaceAll("Milady-dev", "elizaOS")
  .replaceAll("<string>milady</string>", "<string>elizaos</string>");

const hasNodeModules = fs.existsSync(nodeModulesPath);
const hasAgentPackage = fs.existsSync(agentPackageJsonPath);
const agentPackageJson = hasAgentPackage
  ? JSON.parse(fs.readFileSync(agentPackageJsonPath, "utf8"))
  : null;
const nextAgentPackageJson = agentPackageJson
  ? patchAgentPackageExports(agentPackageJson)
  : null;
const agentBefore = agentPackageJson ? JSON.stringify(agentPackageJson) : "";
const agentAfter = nextAgentPackageJson ? JSON.stringify(nextAgentPackageJson) : "";
const missingDependencyLinks = dependencyTargets.filter(({ linkPath, target }) => {
  try {
    return fs.readlinkSync(linkPath) !== target;
  } catch {
    return true;
  }
});
const workspacePackagesStale = syncWorkspaceRuntimePackages({ checkOnly: check });
const runtimePackagePatchWrites = hasNodeModules
  ? [
      ...liveAgentOrchestratorWrites(),
      ...optionalStubPackageWrites(),
      ...sourcePackageManifestWrites(),
      ...lucideReactStubWrites(),
      ...localInferenceFallbackWrites(),
      ...sanitizedCoreRuntimeWrites(),
      ...liveOverlayManifestWrite(),
    ]
  : [];
const runtimePatchWrites = [
  ...runtimePackagePatchWrites,
  ...rendererBrandingWrites(),
];
const staleRuntimePatchWrites = runtimePatchWrites.filter(fileNeedsWrite);
const staleRendererWallpaperTargets = rendererWallpaperTargets().filter(
  (target) => !buffersEqual(rendererWallpaperPath, target),
);
const chromeSandboxPath = path.join(stage, "bin/chrome-sandbox");
const chromeSandboxMode =
  fs.existsSync(chromeSandboxPath) ? fs.statSync(chromeSandboxPath).mode & 0o7777 : null;
const chromeSandboxModeStale =
  chromeSandboxMode !== null && chromeSandboxMode !== 0o755;

if (check) {
  if (
    before !== after ||
    versionBefore !== versionAfter ||
    brandBefore !== brandAfter ||
    infoPlist !== nextInfoPlist ||
    agentBefore !== agentAfter ||
    missingDependencyLinks.length > 0 ||
    workspacePackagesStale ||
    staleRuntimePatchWrites.length > 0 ||
    staleRendererWallpaperTargets.length > 0 ||
    chromeSandboxModeStale
  ) {
    console.error(`${buildJsonPath} is not prepared for elizaOS Live`);
    process.exit(1);
  }
  console.log("Milady app overlay already prepared for elizaOS Live");
  process.exit(0);
}

fs.writeFileSync(buildJsonPath, `${after}\n`);
fs.writeFileSync(versionJsonPath, `${versionAfter}\n`);
fs.writeFileSync(brandConfigPath, `${JSON.stringify(nextBrandConfig, null, "\t")}\n`);
if (infoPlist && infoPlist !== nextInfoPlist) {
  fs.writeFileSync(infoPlistPath, nextInfoPlist);
}
if (nextAgentPackageJson) {
  fs.writeFileSync(agentPackageJsonPath, `${agentAfter}\n`);
}
for (const { linkPath, target } of dependencyTargets) {
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath);
}
for (const { filePath, content } of runtimePatchWrites) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
for (const target of staleRendererWallpaperTargets) {
  fs.copyFileSync(rendererWallpaperPath, target);
}
if (chromeSandboxModeStale) {
  fs.chmodSync(chromeSandboxPath, 0o755);
}
console.log(`Prepared Milady app overlay for elizaOS Live: ${buildJsonPath}`);

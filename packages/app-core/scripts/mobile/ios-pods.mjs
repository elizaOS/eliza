export const MOBILE_CAPACITOR_PLUGIN_MANIFEST = [
  {
    packageName: "@capacitor/app",
    android: { patchAgp9: true },
    iosPods: [
      { name: "CapacitorApp", kind: "official", spmHandling: "incompatible" },
    ],
  },
  {
    packageName: "@capacitor/barcode-scanner",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorBarcodeScanner",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/background-runner",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorBackgroundRunner",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/filesystem",
    iosPods: [
      {
        name: "CapacitorFilesystem",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor-community/background-runner",
    android: { patchAgp9: true },
  },
  {
    packageName: "@capacitor/preferences",
    android: { patchAgp9: true },
    notes:
      "Preferences stays on CocoaPods because the generated iOS SPM package is stripped.",
    iosPods: [
      {
        name: "CapacitorPreferences",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/haptics",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorHaptics",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/keyboard",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorKeyboard",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/network",
    iosPods: [
      {
        name: "CapacitorNetwork",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/push-notifications",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorPushNotifications",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/share",
    iosPods: [
      {
        name: "CapacitorShare",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/browser",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorBrowser",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@capacitor/status-bar",
    android: { patchAgp9: true },
    iosPods: [
      {
        name: "CapacitorStatusBar",
        kind: "official",
        spmHandling: "incompatible",
      },
    ],
  },
  {
    packageName: "@elizaos/capacitor-agent",
    iosPods: [{ name: "ElizaosCapacitorAgent", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-appblocker",
    iosPods: [{ name: "ElizaosCapacitorAppblocker", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-camera",
    iosPods: [{ name: "ElizaosCapacitorCamera", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-calendar",
    iosPods: [{ name: "ElizaosCapacitorCalendar", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-canvas",
    iosPods: [{ name: "ElizaosCapacitorCanvas", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-eliza-tasks",
    iosPods: [{ name: "ElizaosCapacitorElizaTasks", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-gateway",
    iosPods: [{ name: "ElizaosCapacitorGateway", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-location",
    iosPods: [{ name: "ElizaosCapacitorLocation", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-mobile-signals",
    iosPods: [{ name: "ElizaosCapacitorMobileSignals", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-screencapture",
    iosPods: [{ name: "ElizaosCapacitorScreencapture", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-swabble",
    iosPods: [{ name: "ElizaosCapacitorSwabble", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-talkmode",
    iosPods: [{ name: "ElizaosCapacitorTalkmode", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-websiteblocker",
    iosPods: [{ name: "ElizaosCapacitorWebsiteblocker", kind: "custom" }],
  },
  {
    packageName: "@elizaos/capacitor-bun-runtime",
    iosPods: [
      {
        name: "ElizaosCapacitorBunRuntime",
        kind: "custom",
        include: "bunRuntime",
      },
    ],
  },
  {
    packageName: "@elizaos/capacitor-mobile-agent-bridge",
    iosPods: [
      {
        name: "ElizaosCapacitorMobileAgentBridge",
        kind: "custom",
        include: "mobileAgentTunnel",
      },
    ],
  },
  {
    packageName: "llama-cpp-capacitor",
    iosPods: [
      {
        name: "LlamaCpp",
        kind: "custom",
        include: "llama",
        spmHandling: "cocoapods-owned",
      },
      {
        name: "LlamaCppCapacitor",
        kind: "custom",
        include: "llama",
        spmHandling: "cocoapods-owned",
      },
    ],
  },
  {
    packageName: "@elizaos/bun-ios-runtime",
    iosPods: [
      {
        name: "ElizaBunEngine",
        kind: "custom",
        include: "fullBunEngine",
      },
    ],
  },
];

function manifestIosPods() {
  return MOBILE_CAPACITOR_PLUGIN_MANIFEST.flatMap((plugin) =>
    (plugin.iosPods ?? []).map((pod) => ({
      ...pod,
      packageName: plugin.packageName,
    })),
  );
}

function iosPodTuple(pod) {
  return [pod.name, pod.packageName];
}

function shouldIncludeIosCustomPod(pod, context) {
  switch (pod.include ?? "always") {
    case "always":
      return true;
    case "bunRuntime":
      return context.includeBunRuntime;
    case "mobileAgentTunnel":
      return context.includeTunnelBridge;
    case "llama":
      return context.includeLlama && !context.appStoreBuild;
    case "fullBunEngine":
      return context.includeFullBunEngine;
    default:
      throw new Error(`Unknown iOS pod include gate: ${pod.include}`);
  }
}

export const ANDROID_OFFICIAL_CAPACITOR_PACKAGES =
  MOBILE_CAPACITOR_PLUGIN_MANIFEST.filter(
    (plugin) => plugin.android?.patchAgp9,
  ).map((plugin) => plugin.packageName);

export const IOS_OFFICIAL_PODS = manifestIosPods()
  .filter((pod) => pod.kind === "official")
  .map(iosPodTuple);

export function resolveIosCustomPods({
  includeLlama = false,
  includeCompatBunRuntime = false,
  includeFullBunEngine = false,
  appStoreBuild = false,
  includeMobileAgentBridge = false,
} = {}) {
  const includeBunRuntime = includeCompatBunRuntime || includeFullBunEngine;
  const includeTunnelBridge =
    !appStoreBuild && (includeFullBunEngine || includeMobileAgentBridge);
  const context = {
    appStoreBuild,
    includeBunRuntime,
    includeFullBunEngine,
    includeLlama,
    includeTunnelBridge,
  };
  return manifestIosPods()
    .filter((pod) => pod.kind === "custom")
    .filter((pod) => shouldIncludeIosCustomPod(pod, context))
    .map(iosPodTuple);
}

export const IOS_INCOMPATIBLE_SPM_PLUGINS = new Set(
  manifestIosPods()
    .filter((pod) => pod.spmHandling === "incompatible")
    .map((pod) => pod.name),
);

export const IOS_COCOAPODS_OWNED_SPM_PLUGINS = new Set(
  manifestIosPods()
    .filter((pod) => pod.spmHandling === "cocoapods-owned")
    .map((pod) => pod.name),
);

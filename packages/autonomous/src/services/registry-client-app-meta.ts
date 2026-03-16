import { logger } from "@elizaos/core";
import type {
  AppUiExtensionConfig,
  RegistryAppMeta,
  RegistryAppViewerMeta,
} from "./registry-client-types.js";

export const LOCAL_APP_DEFAULT_SANDBOX =
  "allow-scripts allow-same-origin allow-popups";

const ALLOWED_SANDBOX_TOKENS = new Set([
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-same-origin",
  "allow-scripts",
  "allow-storage-access-by-user-activation",
  "allow-top-navigation-by-user-activation",
]);

interface LocalAppOverride {
  displayName?: string;
  category?: string;
  launchType?: string;
  launchUrl?: string | null;
  capabilities?: string[];
  uiExtension?: AppUiExtensionConfig;
  viewer?: RegistryAppViewerMeta;
}

const LOCAL_APP_OVERRIDES: Readonly<Record<string, LocalAppOverride>> = {
  "@elizaos/app-babylon": {
    launchType: "url",
    launchUrl: "http://localhost:3000",
    viewer: {
      url: "http://localhost:3000",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
  },
  "@elizaos/app-hyperscape": {
    launchType: "connect",
    launchUrl: "http://localhost:3333",
    uiExtension: {
      detailPanelId: "hyperscape-embedded-agents",
    },
    viewer: {
      url: "http://localhost:3333",
      embedParams: {
        embedded: "true",
        mode: "spectator",
        quality: "medium",
      },
      postMessageAuth: true,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
  },
  "@elizaos/app-hyperfy": {
    launchType: "connect",
    launchUrl: "http://localhost:3003",
    viewer: {
      url: "http://localhost:3003",
      sandbox: LOCAL_APP_DEFAULT_SANDBOX,
    },
  },
  "@elizaos/app-2004scape": {
    launchType: "connect",
    launchUrl: "http://localhost:8880",
    viewer: {
      url: "http://localhost:8880",
      embedParams: { bot: "{RS_SDK_BOT_NAME}" },
      postMessageAuth: true,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
  },
  "@elizaos/app-agent-town": {
    launchType: "url",
    launchUrl: "http://localhost:5173/ai-town/index.html",
    viewer: {
      url: "http://localhost:5173/ai-town/index.html",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
  },
  "@elizaos/app-dungeons": {
    launchType: "local",
    launchUrl: "http://localhost:3345",
    viewer: {
      url: "http://localhost:3345",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
  },
};

export function sanitizeSandbox(rawSandbox?: string): string {
  if (!rawSandbox || !rawSandbox.trim()) {
    return LOCAL_APP_DEFAULT_SANDBOX;
  }

  const tokens = rawSandbox
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return LOCAL_APP_DEFAULT_SANDBOX;
  }

  for (const token of tokens) {
    if (!ALLOWED_SANDBOX_TOKENS.has(token)) {
      logger.warn(
        `[registry-client] rejecting untrusted sandbox token: ${token}`,
      );
      return LOCAL_APP_DEFAULT_SANDBOX;
    }
  }

  return Array.from(new Set(tokens)).join(" ");
}

function normalizeViewer(
  viewer: RegistryAppViewerMeta | undefined,
): RegistryAppViewerMeta | undefined {
  if (!viewer) return undefined;
  return {
    ...viewer,
    sandbox: sanitizeSandbox(viewer.sandbox),
  };
}

function mergeViewer(
  base: RegistryAppViewerMeta | undefined,
  patch: RegistryAppViewerMeta | undefined,
): RegistryAppViewerMeta | undefined {
  if (!base && !patch) return undefined;
  if (!base) return normalizeViewer(patch);
  if (!patch) return normalizeViewer(base);
  return normalizeViewer({
    ...base,
    ...patch,
    embedParams: {
      ...(base.embedParams ?? {}),
      ...(patch.embedParams ?? {}),
    },
  });
}

export function mergeAppMeta(
  base: RegistryAppMeta | undefined,
  patch: RegistryAppMeta | undefined,
): RegistryAppMeta | undefined {
  if (!base && !patch) return undefined;
  if (!base) return patch;
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    capabilities:
      patch.capabilities.length > 0 ? patch.capabilities : base.capabilities,
    uiExtension: patch.uiExtension ?? base.uiExtension,
    viewer: mergeViewer(base.viewer, patch.viewer),
  };
}

export function resolveAppOverride(
  packageName: string,
  appMeta: RegistryAppMeta | undefined,
): RegistryAppMeta | undefined {
  const override = LOCAL_APP_OVERRIDES[packageName];
  if (!override) return appMeta;
  const base: RegistryAppMeta = appMeta ?? {
    displayName:
      override.displayName ?? packageName.replace(/^@elizaos\/app-/, ""),
    category: override.category ?? "game",
    launchType: override.launchType ?? "url",
    launchUrl: override.launchUrl ?? null,
    icon: null,
    capabilities: override.capabilities ?? [],
    minPlayers: null,
    maxPlayers: null,
    uiExtension: override.uiExtension,
    viewer: override.viewer,
  };
  return {
    ...base,
    displayName: override.displayName ?? base.displayName,
    category: override.category ?? base.category,
    launchType: override.launchType ?? base.launchType,
    launchUrl:
      override.launchUrl !== undefined ? override.launchUrl : base.launchUrl,
    capabilities:
      override.capabilities !== undefined
        ? override.capabilities
        : base.capabilities,
    uiExtension: override.uiExtension ?? base.uiExtension,
    viewer: mergeViewer(base.viewer, override.viewer),
  };
}

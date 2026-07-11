/**
 * AppBootConfig — typed runtime configuration that replaces window.__* globals.
 *
 * The hosting app (e.g. apps/app) creates an AppBootConfig and passes it via
 * <AppBootProvider>. All app-core code reads from this config instead of
 * reaching for window globals.
 *
 * React context lives in `boot-config-react.hooks.ts` so Bun/Node can import
 * this module without loading `react` runtime (avoids Bun parsing @types/react).
 */

import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import type { ComponentType, ReactNode } from "react";
import type { CodingAgentSession } from "../api/client-types-cloud";
import type { BrandingConfig } from "./branding";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A bundled VRM avatar asset descriptor. */
export interface BundledVrmAsset {
  title: string;
  slug: string;
}

/** Lightweight character catalog data passed from the host app. */
export interface CharacterCatalogData {
  assets: CharacterAssetEntry[];
  injectedCharacters: InjectedCharacterEntry[];
}

export interface CharacterAssetEntry {
  id: number;
  slug: string;
  title: string;
  sourceName: string;
}

export interface InjectedCharacterEntry {
  catchphrase: string;
  name: string;
  avatarAssetId: number;
  voicePresetId?: string;
}

/** Resolved character asset with computed paths. */
export interface ResolvedCharacterAsset extends CharacterAssetEntry {
  compressedVrmPath: string;
  rawVrmPath: string;
  previewPath: string;
  backgroundPath: string;
  sourceVrmFilename: string;
}

/** Resolved injected character with its avatar asset. */
export interface ResolvedInjectedCharacter extends InjectedCharacterEntry {
  avatarAsset: ResolvedCharacterAsset;
}

/** Client middleware flags — replaces the 4 monkey-patches. */
export interface ClientMiddleware {
  /** Force fresh first-run setup (e.g. on ?reset). */
  forceFreshFirstRun?: boolean;
  /** Mask cloud status when a local provider is active. */
  preferLocalProvider?: boolean;
  /** Bridge permissions to native desktop layer. */
  desktopPermissions?: boolean;
}

/** Where a home tile sends you. Mirrors HomeTileTarget in shell/HomeScreen. */
export type HomeScreenNavTarget =
  | { kind: "tab"; tab: string }
  | { kind: "view"; path: string };

/** Props the shell passes to a host-provided home screen (boot-config slot). */
export interface HomeScreenComponentProps {
  /** Open a pinned tab/view from a home tile. */
  onOpenTile: (target: HomeScreenNavTarget) => void;
  /** Render the AOSP-only native-OS tiles (phone/contacts/messages). */
  showNativeOsTiles?: boolean;
}

export interface CodingAgentTasksPanelProps {
  fullPage?: boolean;
}

export interface PtyConsoleDrawerProps {
  activeSessionId: string | null;
  sessions: CodingAgentSession[];
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}

export interface FineTuningViewProps {
  contentHeader?: ReactNode;
}

export interface AppBootConfig {
  /** Branding overrides (product name, URLs, etc.). */
  branding: Partial<BrandingConfig>;
  /** Static asset base URL for CDN-backed runtime assets. */
  assetBaseUrl?: string;
  /** Apps starred and pinned by default when no user preference is saved. */
  defaultApps?: readonly string[];
  /** API base URL — replaces window.__ELIZAOS_API_BASE__. */
  apiBase?: string;
  /**
   * VAPID public key (base64url, uncompressed P-256 point) for Web Push
   * subscription. Supplied by the host/boot config; the client passes it as
   * `applicationServerKey` to `pushManager.subscribe`. Absent/blank ⇒ push is
   * unavailable and the settings toggle renders its "not configured" state.
   * The matching private key + cloud sender land in the web-push cloud PR.
   */
  webPushVapidPublicKey?: string;
  /** API auth token used by the browser API client. */
  apiToken?: string;
  /** Cloud API base URL — replaces window.__ELIZA_CLOUD_API_BASE__. */
  cloudApiBase?: string;
  /** VRM avatar assets — replaces window.__APP_VRM_ASSETS__. */
  vrmAssets?: BundledVrmAsset[];
  /** First-run style presets — replaces window.__APP_FIRST_RUN_STYLES__. */
  firstRunStyles?: unknown[];
  /** Character editor component — replaces window.__ELIZAOS_CHARACTER_EDITOR__. */
  characterEditor?: ComponentType<Record<string, unknown>>;
  /**
   * Home screen override provided by the host app. When set, the shell renders
   * this instead of the stock HomeScreen on the /chat home (whitelabel seam for
   * a brand-specific home, e.g. a gold home with a wallet widget). Falls back to
   * the built-in HomeScreen when absent.
   */
  homeScreen?: ComponentType<HomeScreenComponentProps>;
  /**
   * Brand mark (logo glyph) override provided by the host app. Rendered in the
   * startup splash + first-run lockup beside the app name. When set, the shell
   * renders this instead of the built-in ElizaMark (whitelabel seam so a fork
   * shows its own logo, not the elizaOS mark). Receives an optional className.
   */
  brandMark?: ComponentType<{ className?: string }>;
  /** Coding-agent tasks panel provided by the host app. */
  codingAgentTasksPanel?: ComponentType<CodingAgentTasksPanelProps>;
  /** Coding-agent settings panel provided by the host app. */
  codingAgentSettingsSection?: ComponentType<Record<string, never>>;
  /** Coding-agent chat control chip provided by the host app. */
  codingAgentControlChip?: ComponentType<Record<string, never>>;
  /** Coding-agent PTY drawer provided by the host app. */
  ptyConsoleDrawer?: ComponentType<PtyConsoleDrawerProps>;
  /** Fine-tuning view provided by the host app. */
  fineTuningView?: ComponentType<FineTuningViewProps>;
  /** LifeOps browser setup panel provided by the host app. */
  lifeOpsBrowserSetupPanel?: ComponentType<Record<string, never>>;
  /** App blocker settings card provided by the host app. */
  appBlockerSettingsCard?: ComponentType<AppBlockerSettingsCardProps>;
  /** Website blocker settings card provided by the host app. */
  websiteBlockerSettingsCard?: ComponentType<WebsiteBlockerSettingsCardProps>;
  /** Shortcut behavior switches. Natural-language shortcuts are off by default. */
  shortcutFlags?: {
    naturalLanguage?: boolean;
  };
  /**
   * Prefer the instant shared cloud tier during first-run, then hand off to a
   * dedicated agent in the background. Default off: first-run cloud creation
   * should bind the user's dedicated agent directly unless a host explicitly
   * opts into the shared-tier experiment.
   */
  preferSharedCloudTier?: boolean;
  /** Character catalog data — replaces cross-package import of catalog.json. */
  characterCatalog?: CharacterCatalogData;
  /**
   * Env var alias pairs for brand compatibility (e.g. ELIZA_* ↔ ELIZA_*).
   * Each pair is [brandKey, elizaKey]. Called at server startup.
   */
  envAliases?: readonly (readonly [string, string])[];
  /** Client middleware flags — replaces the post-construction patches. */
  clientMiddleware?: ClientMiddleware;
}

// ---------------------------------------------------------------------------
// Defaults (brand-agnostic — no product-specific references)
// ---------------------------------------------------------------------------

export const DEFAULT_BOOT_CONFIG: AppBootConfig = {
  branding: {},
  cloudApiBase: "https://elizacloud.ai",
  preferSharedCloudTier: false,
};

// ---------------------------------------------------------------------------
// Process-global config ref (for non-React code like client.ts, asset-url.ts)
// Use a Symbol-backed slot on globalThis so duplicated module instances
// still read/write the same live boot config.
// ---------------------------------------------------------------------------

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

interface BootConfigStore {
  current: AppBootConfig;
}

type GlobalConfigSlot = Record<PropertyKey, unknown> & {
  [K in typeof BOOT_CONFIG_WINDOW_KEY]?: AppBootConfig;
};

/** Resolve the global object (browser or Node) with symbol-key access. */
function getGlobalSlot(): GlobalConfigSlot {
  return globalThis as GlobalConfigSlot;
}

function getBootConfigStore(): BootConfigStore {
  const globalObject = getGlobalSlot();

  // An established store always wins. The window-key mirror is only a pre-boot
  // seed and must never replace a store that already exists — see the matching
  // note in `@elizaos/core`'s boot-env.ts. All three copies (core, shared, ui)
  // share the same global slot, so they must agree on write-once semantics.
  const existing = globalObject[BOOT_CONFIG_STORE_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "current" in (existing as Record<string, unknown>)
  ) {
    return existing as BootConfigStore;
  }

  // No store yet: seed it once from a cross-bundle window mirror if a bootstrap
  // set it, otherwise from defaults.
  const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
  const store: BootConfigStore = {
    current: mirroredWindowConfig ?? DEFAULT_BOOT_CONFIG,
  };
  globalObject[BOOT_CONFIG_STORE_KEY] = store;
  globalObject[BOOT_CONFIG_WINDOW_KEY] = store.current;
  return store;
}

/** Set the boot config. Called by AppBootProvider on mount. */
export function setBootConfig(config: AppBootConfig): void {
  const store = getBootConfigStore();
  store.current = config;
  getGlobalSlot()[BOOT_CONFIG_WINDOW_KEY] = config;
}

/** Read the boot config from non-React code. */
export function getBootConfig(): AppBootConfig {
  return getBootConfigStore().current;
}

// ---------------------------------------------------------------------------
// Character catalog helpers
// ---------------------------------------------------------------------------

function resolveAssets(
  catalog: CharacterCatalogData,
): ResolvedCharacterAsset[] {
  return catalog.assets.map((asset) => ({
    ...asset,
    compressedVrmPath: `vrms/${asset.slug}.vrm.gz`,
    rawVrmPath: `vrms/${asset.slug}.vrm`,
    previewPath: `vrms/previews/${asset.slug}.png`,
    backgroundPath: `vrms/backgrounds/${asset.slug}.png`,
    sourceVrmFilename: `${asset.sourceName}.vrm`,
  }));
}

/** Resolve a character catalog into ready-to-use assets and characters. */
export function resolveCharacterCatalog(catalog: CharacterCatalogData): {
  assets: ResolvedCharacterAsset[];
  assetCount: number;
  defaultAsset: ResolvedCharacterAsset | null;
  injectedCharacters: ResolvedInjectedCharacter[];
  injectedCharacterCount: number;
  getAsset: (id: number) => ResolvedCharacterAsset | null;
  getInjectedCharacter: (
    catchphrase: string,
  ) => ResolvedInjectedCharacter | null;
} {
  const assets = resolveAssets(catalog);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const defaultAsset = assets[0] ?? null;

  const injectedCharacters = catalog.injectedCharacters.map((character) => {
    const avatarAsset = assetById.get(character.avatarAssetId) ?? defaultAsset;
    if (!avatarAsset) {
      throw new Error(
        `Missing avatar asset ${character.avatarAssetId} for ${character.name}.`,
      );
    }
    return { ...character, avatarAsset };
  });

  const byCatchphrase = new Map(
    injectedCharacters.map((c) => [c.catchphrase, c]),
  );

  return {
    assets,
    assetCount: assets.length,
    defaultAsset,
    injectedCharacters,
    injectedCharacterCount: injectedCharacters.length,
    getAsset: (id: number) => assetById.get(id) ?? defaultAsset,
    getInjectedCharacter: (catchphrase: string) =>
      byCatchphrase.get(catchphrase) ?? null,
  };
}

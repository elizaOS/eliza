export interface BrandingConfig {
  appName?: string;
  orgName?: string;
  repoName?: string;
  docsUrl?: string;
  appUrl?: string;
  bugReportUrl?: string;
  hashtag?: string;
  fileExtension?: string;
  packageScope?: string;
  cloudOnly?: boolean;
}

export interface CharacterCatalogData {
  assets: unknown[];
  injectedCharacters: unknown[];
}

export interface AppBootConfig {
  apiBase?: string;
  assetBaseUrl?: string;
  branding: Partial<BrandingConfig>;
  characterCatalog?: CharacterCatalogData;
  characterEditor?: unknown;
  clientMiddleware?: Record<string, unknown>;
  cloudApiBase?: string;
  companionShell?: unknown;
  envAliases?: readonly (readonly [string, string])[];
  lifeOpsBrowserSetupPanel?: unknown;
  lifeOpsPageView?: unknown;
  onboardingStyles?: unknown[];
  vrmAssets?: Array<{ slug: string; title: string }>;
  websiteBlockerSettingsCard?: unknown;
}

export function getBootConfig(): AppBootConfig;
export function setBootConfig(config: AppBootConfig): void;
export function shouldUseCloudOnlyBranding(options: {
  injectedApiBase?: string;
  isDev: boolean;
  isNativePlatform: boolean;
}): boolean;

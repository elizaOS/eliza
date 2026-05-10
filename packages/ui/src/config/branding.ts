/**
 * Custom provider that apps can inject into the onboarding flow.
 * Uses `string` for id/family so apps aren't restricted to the built-in union.
 */
export interface CustomProviderOption {
  id: string;
  name: string;
  envKey: string | null;
  pluginName: string;
  keyPrefix: string | null;
  description: string;
  family: string;
  authMode: "api-key" | "cloud" | "credentials" | "local" | "subscription";
  group: "cloud" | "local" | "subscription";
  order: number;
  recommended?: boolean;
  /** Dark-mode logo path (e.g. "/logos/my-provider.png") */
  logoDark?: string;
  /** Light-mode logo path */
  logoLight?: string;
}

export interface OnboardingThemeConfig {
  background?: string;
  foreground?: string;
  mutedForeground?: string;
  controlBackground?: string;
  controlForeground?: string;
  buttonBackground?: string;
  buttonForeground?: string;
  buttonHighlightBackground?: string;
  inputBackground?: string;
  inputForeground?: string;
  errorForeground?: string;
}

export interface BrandingConfig {
  /** Product name shown in UI ("Eliza" | "the app") */
  appName: string;
  /** GitHub org ("elizaos" | "elizaos") */
  orgName: string;
  /** GitHub repo name ("eliza" | "eliza") */
  repoName: string;
  /** Documentation site URL */
  docsUrl: string;
  /** App origin URL */
  appUrl: string;
  /** GitHub bug report URL */
  bugReportUrl: string;
  /** Twitter hashtag ("#ElizaAgent" | "#AppAgent") */
  hashtag: string;
  /** Agent file extension (".eliza-agent" | ".eliza-agent") */
  fileExtension: string;
  /** npm package scope ("elizaos" | "elizaos") */
  packageScope: string;
  /** Custom providers injected by the app into the onboarding flow */
  customProviders?: CustomProviderOption[];
  /** Optional CSS color tokens for branded onboarding screens. */
  onboardingTheme?: OnboardingThemeConfig;
  /** When true, the app requires Eliza Cloud — local backend mode is disabled. */
  cloudOnly?: boolean;
}

/** Default for i18n copy that uses `{{appName}}` (e.g. "Where should {{appName}} run?"). */
export const DEFAULT_APP_DISPLAY_NAME = "Eliza";

export const DEFAULT_BRANDING: BrandingConfig = {
  appName: DEFAULT_APP_DISPLAY_NAME,
  orgName: "elizaos",
  repoName: "eliza",
  docsUrl: "https://docs.elizaos.ai",
  appUrl: "https://app.elizaos.ai",
  bugReportUrl:
    "https://github.com/elizaos/eliza/issues/new?template=bug_report.yml",
  hashtag: "#ElizaAgent",
  fileExtension: ".eliza-agent",
  packageScope: "elizaos",
};

// React-bound BrandingContext + useBranding live in
// `./branding-react.tsx` so `@elizaos/shared` can be imported from
// node-side benchmark / agent code without dragging React into the
// runtime closure (the bench server fails to boot otherwise).

/** Pass to `t(key, appNameInterpolationVars(branding))` when the string contains `{{appName}}`. */
export function appNameInterpolationVars(branding: BrandingConfig): {
  appName: string;
} {
  const name = branding.appName?.trim();
  return { appName: name || DEFAULT_APP_DISPLAY_NAME };
}

export { BrandingContext, useBranding } from "./branding-react";

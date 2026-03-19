import { createContext, useContext } from "react";

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

export interface BrandingConfig {
  /** Product name shown in UI ("Eliza" | "Milady") */
  appName: string;
  /** GitHub org ("elizaos" | "milady-ai") */
  orgName: string;
  /** GitHub repo name ("eliza" | "milady") */
  repoName: string;
  /** Documentation site URL */
  docsUrl: string;
  /** App origin URL */
  appUrl: string;
  /** GitHub bug report URL */
  bugReportUrl: string;
  /** Twitter hashtag ("#ElizaAgent" | "#MiladyAgent") */
  hashtag: string;
  /** Agent file extension (".eliza-agent" | ".milady-agent") */
  fileExtension: string;
  /** npm package scope ("elizaos" | "miladyai") */
  packageScope: string;
  /** Custom providers injected by the app into the onboarding flow */
  customProviders?: CustomProviderOption[];
  /** When true, the app requires Eliza Cloud — local backend mode is disabled. */
  cloudOnly?: boolean;
}

export const DEFAULT_BRANDING: BrandingConfig = {
  appName: "Eliza",
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

export const BrandingContext = createContext<BrandingConfig>(DEFAULT_BRANDING);

export function useBranding(): BrandingConfig {
  return useContext(BrandingContext);
}

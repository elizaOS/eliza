import { createContext, useContext } from "react";

export interface BrandingConfig {
  /** Product name shown in UI ("Eliza" | "Milady") */
  appName: string;
  /** Cloud service name ("Eliza Cloud" | "Milady Cloud") */
  cloudName: string;
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
}

export const DEFAULT_BRANDING: BrandingConfig = {
  appName: "Eliza",
  cloudName: "Eliza Cloud",
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

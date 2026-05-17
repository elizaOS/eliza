export type TemplateId = "plugin" | "project";

export interface TemplateUpstream {
  path: string;
  repo: string;
  branch?: string;
  mode: "git-submodule";
  requiredSubmodules?: string[];
  requiredWorkspaces?: string[];
}

export interface TemplateDefinition {
  aliases?: string[];
  id: TemplateId;
  name: string;
  description: string;
  kind: TemplateId;
  version: number;
  languages: string[];
  upstream?: TemplateUpstream;
}

export interface TemplatesManifest {
  version: string;
  generatedAt: string;
  repoUrl: string;
  templates: TemplateDefinition[];
}

export interface CreateOptions {
  template?: string;
  language?: string;
  yes?: boolean;
  description?: string;
  githubUsername?: string;
  repoUrl?: string;
  skipUpstream?: boolean;
}

export interface InfoOptions {
  template?: string;
  language?: string;
  json?: boolean;
}

export interface UpgradeOptions {
  check?: boolean;
  dryRun?: boolean;
  skipUpstream?: boolean;
}

export interface PluginTemplateValues extends Record<string, string> {
  displayName: string;
  elizaVersion: string;
  githubUsername: string;
  pluginBaseName: string;
  pluginDescription: string;
  pluginSnake: string;
  repoUrl: string;
}

export interface FullstackTemplateValues extends Record<string, string> {
  appName: string;
  appUrl: string;
  bugReportUrl: string;
  bundleId: string;
  docsUrl: string;
  fileExtension: string;
  hashtag: string;
  orgName: string;
  packageScope: string;
  projectSlug: string;
  releaseBaseUrl: string;
  repoName: string;
}

export interface ProjectTemplateMetadata {
  cliVersion: string;
  createdAt: string;
  language?: string;
  managedFiles: Record<string, string>;
  templateId: TemplateId;
  templateVersion: number;
  updatedAt: string;
  values: Record<string, string>;
}

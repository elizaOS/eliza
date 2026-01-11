/**
 * Type definitions for elizaOS CLI
 */

export interface ExampleLanguage {
  language: string;
  path: string;
  hasPackageJson?: boolean;
  hasRequirementsTxt?: boolean;
  hasCargoToml?: boolean;
  hasPyprojectToml?: boolean;
}

export interface Example {
  name: string;
  description: string;
  path: string;
  languages: ExampleLanguage[];
  category: string;
}

export interface ExamplesManifest {
  version: string;
  generatedAt: string;
  repoUrl: string;
  examples: Example[];
  categories: string[];
  languages: string[];
}

export interface CreateOptions {
  language?: string;
  example?: string;
  yes?: boolean;
}

export interface InfoOptions {
  language?: string;
  json?: boolean;
}

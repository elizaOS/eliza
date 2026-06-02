/**
 * Types for the elizaOS community plugin registry.
 *
 * Two formats live in this package:
 *
 * 1. {@link RegistryEntry} — the human/CLI-authored source format, one JSON file
 *    per package under `entries/third-party/`. This is what `elizaos plugins
 *    submit --dry-run` emits and what contributors add by pull request.
 * 2. {@link GeneratedRegistry} — the wire format the runtime consumes from
 *    `plugins.elizacloud.ai/generated-registry.json`. Produced from the source
 *    entries by {@link generateRegistry}.
 */

/** The kind of artifact a registry entry describes. */
export type RegistryEntryKind = "plugin" | "connector" | "app";

/**
 * Source format for a single third-party registry entry. Mirrors the metadata
 * `elizaos plugins submit` generates from a plugin's `package.json`.
 */
export interface RegistryEntry {
  /** npm package name. The `@elizaos/*` scope is reserved for first-party. */
  package: string;
  /** GitHub repository as `github:owner/repo`. */
  repository: string;
  /** What this package is. */
  kind: RegistryEntryKind;
  /** One-line description. */
  description?: string;
  /** Project homepage URL. */
  homepage?: string;
  /** Published npm version this entry was registered against. */
  version?: string;
  /** Monorepo subdirectory when the package lives inside a larger repo. */
  directory?: string;
  /** Discovery tags (npm keywords minus elizaos boilerplate). */
  tags?: string[];
}

/** Per-package entry in the generated wire registry. */
export interface GeneratedRegistryEntry {
  git: {
    repo: string;
    v0: { branch: string | null };
    v1: { branch: string | null };
    v2: { branch: string | null };
  };
  npm: {
    repo: string;
    v0: string | null;
    v1: string | null;
    v2: string | null;
  };
  supports: { v0: boolean; v1: boolean; v2: boolean };
  description: string;
  homepage: string | null;
  topics: string[];
  stargazers_count: number;
  language: string;
  origin: "third-party";
  source: "community";
  support: "community";
  builtIn: false;
  firstParty: false;
  thirdParty: true;
  kind: RegistryEntryKind;
  registryKind: RegistryEntryKind;
  directory: string | null;
}

/** Top-level wire format served to the runtime. */
export interface GeneratedRegistry {
  registry: Record<string, GeneratedRegistryEntry>;
}

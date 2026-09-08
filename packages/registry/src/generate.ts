/**
 * Converts validated community registry entries into the generated wire format.
 * This module is import-safe; filesystem output belongs to the separate CLI entrypoint.
 */

import { loadThirdPartyEntries } from "./loader.ts";
import type {
  GeneratedRegistry,
  GeneratedRegistryEntry,
  RegistryEntry,
} from "./types.ts";

function repoSlug(repository: string): string {
  return repository.replace(/^github:/, "");
}

/** Map one source entry into its wire-format counterpart. */
export function toGeneratedEntry(entry: RegistryEntry): GeneratedRegistryEntry {
  return {
    git: {
      repo: repoSlug(entry.repository),
      v0: { branch: null },
      v1: { branch: null },
      v2: { branch: "main" },
    },
    npm: {
      repo: entry.package,
      v0: null,
      v1: null,
      v2: entry.version ?? null,
    },
    supports: { v0: false, v1: false, v2: true },
    description: entry.description ?? "",
    homepage: entry.homepage ?? null,
    topics: entry.tags ?? [],
    stargazers_count: 0,
    language: "TypeScript",
    origin: "third-party",
    source: "community",
    support: "community",
    builtIn: false,
    firstParty: false,
    thirdParty: true,
    kind: entry.kind,
    registryKind: entry.kind,
    directory: entry.directory ?? null,
    app: entry.app
      ? {
          ...entry.app,
          heroImage: entry.app.heroImage ?? null,
          minPlayers: entry.app.minPlayers ?? null,
          maxPlayers: entry.app.maxPlayers ?? null,
          capabilities: [...entry.app.capabilities],
          uiExtension: entry.app.uiExtension
            ? { ...entry.app.uiExtension }
            : undefined,
          viewer: entry.app.viewer
            ? {
                ...entry.app.viewer,
                embedParams: entry.app.viewer.embedParams
                  ? { ...entry.app.viewer.embedParams }
                  : undefined,
              }
            : undefined,
          session: entry.app.session
            ? {
                ...entry.app.session,
                features: entry.app.session.features
                  ? [...entry.app.session.features]
                  : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}

/** Build the full wire registry from the source entries on disk. */
export function generateRegistry(
  entries = loadThirdPartyEntries(),
): GeneratedRegistry {
  const registry: Record<string, GeneratedRegistryEntry> = {};
  for (const entry of entries) {
    registry[entry.package] = toGeneratedEntry(entry);
  }
  return { registry };
}

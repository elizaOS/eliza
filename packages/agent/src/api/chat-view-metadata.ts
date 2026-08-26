/**
 * Resolve renderer chat metadata against the authoritative runtime view
 * registry. The renderer supplies the visible path; the server supplies the
 * exact view id, declared agent capabilities, and relevant runtime actions.
 * This keeps typed chat and voice-transcription turns on the same contract
 * without teaching either transport about individual plugins.
 */

import type { ViewRegistryEntry } from "./view-registry-types.ts";
import { listViews } from "./views-registry.ts";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = asString(entry);
    return parsed ? [parsed] : [];
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeViewPath(value: unknown): string | null {
  const path = asString(value);
  if (!path) return null;
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  if (!withoutQuery) return null;
  const rooted = withoutQuery.startsWith("/")
    ? withoutQuery
    : `/${withoutQuery}`;
  return rooted.length > 1 && rooted.endsWith("/")
    ? rooted.slice(0, -1)
    : rooted;
}

function viewPathMatches(
  candidatePath: string,
  registeredPath: string,
): boolean {
  return (
    candidatePath === registeredPath ||
    (registeredPath !== "/" && candidatePath.startsWith(`${registeredPath}/`))
  );
}

/**
 * Resolve the most-specific GUI view for renderer metadata. Path wins over the
 * renderer's view id because older clients intentionally report broad ids such
 * as "system" or "apps" for several distinct fullscreen views.
 */
export function resolveChatMetadataView(
  metadata: Record<string, unknown>,
  views: readonly ViewRegistryEntry[],
): ViewRegistryEntry | null {
  const candidatePath = normalizeViewPath(metadata.uiViewPath);
  if (candidatePath) {
    const byPath = views
      .flatMap((view) => {
        const registeredPath = normalizeViewPath(view.path);
        return registeredPath && viewPathMatches(candidatePath, registeredPath)
          ? [{ view, registeredPath }]
          : [];
      })
      .sort((a, b) => b.registeredPath.length - a.registeredPath.length)[0];
    if (byPath) return byPath.view;
  }

  const candidateId = asString(metadata.uiView);
  if (!candidateId) return null;
  return views.find((view) => view.id === candidateId) ?? null;
}

/**
 * Add registry-owned view facts to renderer metadata. Unknown paths and
 * non-renderer API turns are preserved unchanged. These fields affect planner
 * relevance only; normal role, context, policy, validation, and execution
 * gates remain authoritative.
 */
export function enrichChatUiViewMetadata(
  metadata: Record<string, unknown> | undefined,
  views: readonly ViewRegistryEntry[] = listViews({
    developerMode: true,
    includeAllKinds: true,
    viewType: "gui",
  }),
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const {
    uiViewActionNames: _callerActionNames,
    ...metadataWithoutActionNames
  } = metadata;
  if (
    !asString(metadata.uiView) &&
    !asString(metadata.uiViewPath) &&
    !Array.isArray(metadata.uiViewCapabilities)
  ) {
    return _callerActionNames === undefined
      ? metadata
      : metadataWithoutActionNames;
  }

  const view = resolveChatMetadataView(metadata, views);
  if (!view) {
    const { uiViewCapabilities: _callerCapabilities, ...unresolvedMetadata } =
      metadataWithoutActionNames;
    return unresolvedMetadata;
  }

  const declaredCapabilities = uniqueStrings(
    (view.capabilities ?? [])
      .filter((capability) => capability.authority !== "human")
      .map((capability) => capability.id),
  );
  const rendererCapabilities = asStringList(metadata.uiViewCapabilities);
  const viewActionNames = uniqueStrings([
    ...(view.relatedActions ?? []),
    ...(view.scopedActions ?? []).map((action) => action.name),
  ]);

  return {
    ...metadataWithoutActionNames,
    uiView: view.id,
    uiViewPath:
      normalizeViewPath(metadata.uiViewPath) ?? view.path ?? undefined,
    uiViewCapabilities:
      declaredCapabilities.length > 0
        ? declaredCapabilities
        : rendererCapabilities,
    uiViewActionNames: viewActionNames,
  };
}

/**
 * Pure text/URL helpers for the Release Center: `summarizeError` (message from
 * an unknown throwable), `normalizeReleaseNotesUrl` (validated URL, falling back
 * to the GitHub releases page), and `partitionDescription` (localized label for
 * a desktop session partition). No React.
 */

import { EXTERNAL_URLS } from "@elizaos/shared/brand";

const DEFAULT_RELEASE_NOTES_URL = `${EXTERNAL_URLS.github}/releases`;

export function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeReleaseNotesUrl(url?: string | null): string {
  const candidate = url?.trim() || DEFAULT_RELEASE_NOTES_URL;
  try {
    return new URL(candidate).toString();
  } catch {
    return DEFAULT_RELEASE_NOTES_URL;
  }
}

export function partitionDescription(
  partition: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return partition === "persist:default"
    ? t("releasecenter.RendererDefaultSession", {
        defaultValue: "Renderer default session",
      })
    : t("releasecenter.SandboxedReleaseNotesSession", {
        defaultValue: "Sandboxed release notes session",
      });
}

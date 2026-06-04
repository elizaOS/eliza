export function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeReleaseNotesUrl(url?: string | null): string {
  const candidate = url?.trim() || "https://elizaos.ai/releases/";
  try {
    return new URL(candidate).toString();
  } catch {
    return "https://elizaos.ai/releases/";
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

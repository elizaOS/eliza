// Shared (non-component) helpers for the 2004scape operator surface. Kept out of
// TwoThousandFourScapeOperatorSurface.tsx so that file exports only React
// components and stays Fast-Refresh-compatible. Used by both the view components
// and the view-bundle `interact` handler.

export interface AppRunCommandResponse {
  success: boolean;
  message: string;
}

export async function postAppRunCommand(
  runId: string,
  path: "message" | "control",
  body: Record<string, string>,
): Promise<AppRunCommandResponse> {
  const response = await fetch(
    `/api/apps/runs/${encodeURIComponent(runId)}/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return {
    success: Boolean(data.success),
    message:
      typeof data.message === "string" && data.message.trim().length > 0
        ? data.message.trim()
        : response.status === 202
          ? "Command queued."
          : response.status >= 500
            ? "Command unavailable."
            : "Command rejected.",
  };
}

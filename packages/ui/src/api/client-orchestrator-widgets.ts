/**
 * Compact orchestrator widget API for bounded JSON snapshots and named SSE
 * updates. The detailed task workbench keeps its larger API in client-agent;
 * this module owns only the small projection rendered by task summary rails.
 */

import { openEventSource } from "../utils/event-source";
import { ElizaClient } from "./client-base";

export type OrchestratorWidgetStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed";

export interface OrchestratorWidgetTask {
  taskId: string;
  label: string;
  status: OrchestratorWidgetStatus;
  model?: string;
  account?: {
    providerId?: string;
    accountId?: string;
    label?: string;
  };
  progressSummary: string;
  evidenceLinks: Array<{ label: string; href: string }>;
  timestamps: {
    createdAt: string;
    updatedAt: string;
    completedAt?: string | null;
  };
  parentTaskId?: string;
  childTaskIds: string[];
}

export interface OrchestratorWidgetSnapshot {
  version: "orchestrator.widgets.v1";
  generatedAt: string;
  totalTaskCount: number;
  tasks: OrchestratorWidgetTask[];
}

export interface OrchestratorWidgetOptions {
  includeArchived?: boolean;
  projectId?: string;
  limit?: number;
}

declare module "./client-base" {
  interface ElizaClient {
    getOrchestratorWidgets(
      options?: OrchestratorWidgetOptions,
    ): Promise<OrchestratorWidgetSnapshot>;
    streamOrchestratorWidgets(
      options: OrchestratorWidgetOptions | undefined,
      onSnapshot: (snapshot: OrchestratorWidgetSnapshot) => void,
      onError: (error: Error) => void,
    ): () => void;
  }
}

function widgetQuery(options?: OrchestratorWidgetOptions): string {
  const params = new URLSearchParams();
  if (options?.includeArchived) params.set("includeArchived", "true");
  if (options?.projectId) params.set("projectId", options.projectId);
  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

ElizaClient.prototype.getOrchestratorWidgets = function (
  this: ElizaClient,
  options,
) {
  return this.fetch<OrchestratorWidgetSnapshot>(
    `/api/orchestrator/widgets${widgetQuery(options)}`,
  );
};

ElizaClient.prototype.streamOrchestratorWidgets = function (
  this: ElizaClient,
  options,
  onSnapshot,
  onError,
) {
  const url = `${this.baseUrl || ""}/api/orchestrator/widgets/stream${widgetQuery(options)}`;
  const source = openEventSource(url);
  if (!source) return () => undefined;

  source.addEventListener("snapshot", (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent<string>).data));
    } catch (error) {
      onError(
        error instanceof Error
          ? error
          : new Error("Invalid orchestrator widget snapshot"),
      );
    }
  });
  source.addEventListener("error", (event) => {
    const data = (event as MessageEvent<string>).data;
    if (typeof data === "string" && data.length > 0) {
      try {
        const payload = JSON.parse(data) as { error?: unknown };
        if (typeof payload.error === "string") {
          onError(new Error(payload.error));
          return;
        }
      } catch (error) {
        // error-policy:J3 malformed terminal SSE data becomes an explicit client error.
        onError(
          new Error("Orchestrator task stream returned invalid error data", {
            cause: error,
          }),
        );
        return;
      }
    }
    onError(new Error("Orchestrator task stream disconnected"));
  });
  return () => source.close();
};

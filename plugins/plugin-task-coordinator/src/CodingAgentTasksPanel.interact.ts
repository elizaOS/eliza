// View-bundle `interact` capability handler, split out of
// CodingAgentTasksPanel.tsx so that file exports only React components and
// stays Fast-Refresh-compatible (Vite would full-reload a component file that
// also exports a plain function). The view bundle re-exports `interact` via
// ./task-coordinator-view-bundle.ts. Orchestrator capabilities are delegated to
// runOrchestratorCapability; the remaining ids drive the task-coordinator view.
import { client } from "@elizaos/ui";
import {
  ORCHESTRATOR_CAPABILITY_IDS,
  runOrchestratorCapability,
} from "./orchestrator-capabilities";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (ORCHESTRATOR_CAPABILITY_IDS.has(capability)) {
    return runOrchestratorCapability(capability, params);
  }

  if (capability === "list-sessions" || capability === "refresh") {
    return client.getCodingAgentStatus();
  }

  if (capability === "list-task-threads") {
    return client.listCodingAgentTaskThreads({
      includeArchived: params?.includeArchived === true,
      search: typeof params?.search === "string" ? params.search : undefined,
      limit: typeof params?.limit === "number" ? params.limit : 30,
    });
  }

  if (capability === "open-thread") {
    const threadId =
      typeof params?.threadId === "string" ? params.threadId.trim() : "";
    if (threadId) {
      return client.getCodingAgentTaskThread(threadId);
    }
    const [firstThread] = await client.listCodingAgentTaskThreads({
      includeArchived: false,
      limit: 1,
    });
    return firstThread ? client.getCodingAgentTaskThread(firstThread.id) : null;
  }

  if (capability === "stop-session") {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
    if (!sessionId) {
      return {
        stopped: false,
        reason: "sessionId is required to stop a coding agent session",
      };
    }
    return client.stopCodingAgent(sessionId);
  }

  throw new Error(`Task Coordinator TUI does not support "${capability}".`);
}

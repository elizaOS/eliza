// Voice/chat capability dispatch for the `/orchestrator` view, split out of
// OrchestratorWorkbench.tsx so that file exports only React components and
// stays Fast-Refresh-compatible. These ids are declared on the `/orchestrator`
// view and routed through the bundle's shared `interact` export so the agent
// can drive the workbench by voice or chat. Every handler maps 1:1 to a client
// method.
import { client } from "@elizaos/ui";
import {
  paramPriority,
  paramString,
  paramStringArray,
  requireTaskId,
  TASK_LIST_LIMIT,
} from "./orchestrator-params";

export const ORCHESTRATOR_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "orchestrator-status",
  "orchestrator-list-tasks",
  "orchestrator-open-task",
  "orchestrator-create-task",
  "orchestrator-pause-task",
  "orchestrator-resume-task",
  "orchestrator-pause-all",
  "orchestrator-resume-all",
  "orchestrator-delete-task",
  "orchestrator-fork-task",
  "orchestrator-update-task",
  "orchestrator-validate-task",
  "orchestrator-add-agent",
  "orchestrator-stop-agent",
  "orchestrator-send-message",
]);

export async function runOrchestratorCapability(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  switch (capability) {
    case "orchestrator-status":
      return client.getOrchestratorStatus();
    case "orchestrator-list-tasks":
      return client.listCodingAgentTaskThreads({
        includeArchived: params?.includeArchived === true,
        status: paramString(params?.status),
        search: paramString(params?.search),
        limit:
          typeof params?.limit === "number" ? params.limit : TASK_LIST_LIMIT,
      });
    case "orchestrator-open-task": {
      const taskId = paramString(params?.taskId);
      if (taskId) return client.getCodingAgentTaskThread(taskId);
      const [first] = await client.listCodingAgentTaskThreads({ limit: 1 });
      return first ? client.getCodingAgentTaskThread(first.id) : null;
    }
    case "orchestrator-create-task": {
      const title = paramString(params?.title);
      const goal = paramString(params?.goal);
      if (!title || !goal) {
        throw new Error("title and goal are required to create a task.");
      }
      return client.createOrchestratorTask({
        title,
        goal,
        originalRequest: paramString(params?.originalRequest),
        kind: paramString(params?.kind),
        priority: paramPriority(params?.priority),
        acceptanceCriteria: paramStringArray(params?.acceptanceCriteria),
      });
    }
    case "orchestrator-pause-task":
      return client.pauseOrchestratorTask(requireTaskId(params));
    case "orchestrator-resume-task":
      return client.resumeOrchestratorTask(requireTaskId(params));
    case "orchestrator-pause-all":
      return { paused: await client.pauseAllOrchestratorTasks() };
    case "orchestrator-resume-all":
      return { resumed: await client.resumeAllOrchestratorTasks() };
    case "orchestrator-delete-task":
      return {
        deleted: await client.deleteOrchestratorTask(requireTaskId(params)),
      };
    case "orchestrator-fork-task":
      return client.forkOrchestratorTask(requireTaskId(params), {
        title: paramString(params?.title),
        goal: paramString(params?.goal),
        priority: paramPriority(params?.priority),
        acceptanceCriteria: paramStringArray(params?.acceptanceCriteria),
      });
    case "orchestrator-update-task":
      return client.updateOrchestratorTask(requireTaskId(params), {
        title: paramString(params?.title),
        goal: paramString(params?.goal),
        summary: paramString(params?.summary),
        priority: paramPriority(params?.priority),
        acceptanceCriteria: paramStringArray(params?.acceptanceCriteria),
      });
    case "orchestrator-validate-task": {
      if (typeof params?.passed !== "boolean") {
        throw new Error("passed (boolean) is required to validate a task.");
      }
      return client.validateOrchestratorTask(requireTaskId(params), {
        passed: params.passed,
        summary: paramString(params?.summary),
        evidence: paramString(params?.evidence),
        verifier: paramString(params?.verifier),
        humanOverride: params?.humanOverride === true,
      });
    }
    case "orchestrator-add-agent":
      return client.addOrchestratorAgent(requireTaskId(params), {
        framework: paramString(params?.framework),
        providerSource: paramString(params?.providerSource),
        model: paramString(params?.model),
        workdir: paramString(params?.workdir),
        repo: paramString(params?.repo),
        label: paramString(params?.label),
        task: paramString(params?.task),
      });
    case "orchestrator-stop-agent": {
      const sessionId = paramString(params?.sessionId);
      if (!sessionId)
        throw new Error("sessionId is required to stop an agent.");
      return {
        stopped: await client.stopOrchestratorAgent(
          requireTaskId(params),
          sessionId,
        ),
      };
    }
    case "orchestrator-send-message": {
      const content = paramString(params?.content);
      if (!content) throw new Error("content is required to send a message.");
      return {
        sent: await client.postOrchestratorTaskMessage(
          requireTaskId(params),
          content,
        ),
      };
    }
    default:
      throw new Error(`Orchestrator view does not support "${capability}".`);
  }
}

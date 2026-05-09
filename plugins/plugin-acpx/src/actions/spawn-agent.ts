import type { Action, ActionResult } from "@elizaos/core";
import type { AgentType } from "../services/types.js";
import {
  callbackText,
  contentRecord,
  errorResult,
  failureMessage,
  getAcpService,
  type HandlerOptionsLike,
  hasExplicitPayload,
  isAuthError,
  logger,
  looksLikeTaskAgentRequest,
  messageText,
  paramsRecord,
  parseApproval,
  pickBoolean,
  pickString,
  setCurrentSession,
} from "./common.js";

export const spawnAgentAction = {
  name: "SPAWN_AGENT",
  roleGate: { minRole: "OWNER" },
  similes: [
    "SPAWN_CODING_AGENT",
    "START_CODING_AGENT",
    "LAUNCH_CODING_AGENT",
    "CREATE_CODING_AGENT",
    "SPAWN_CODER",
    "RUN_CODING_AGENT",
    "SPAWN_SUB_AGENT",
    "START_TASK_AGENT",
    "CREATE_AGENT",
  ],
  description:
    "Spawn a specific task agent inside an existing workspace for open-ended coding, research, planning, testing, documentation, media/file asset work, or async repo work. Returns a session ID for follow-up actions.",
  suppressPostActionContinuation: true,
  parameters: [
    { name: "agentType", required: false, schema: { type: "string" } },
    { name: "task", required: false, schema: { type: "string" } },
    { name: "workdir", required: false, schema: { type: "string" } },
    { name: "memoryContent", required: false, schema: { type: "string" } },
    {
      name: "approvalPreset",
      required: false,
      schema: {
        type: "string",
        enum: ["readonly", "standard", "permissive", "autonomous"],
      },
    },
    {
      name: "keepAliveAfterComplete",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async (runtime, message) => {
    if (!getAcpService(runtime)) return false;
    if (hasExplicitPayload(message, ["task", "workdir", "agentType"]))
      return true;
    const text = messageText(message);
    if (!text.trim()) return true;
    return looksLikeTaskAgentRequest(text);
  },
  handler: async (
    runtime,
    message,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const service = getAcpService(runtime);
    if (!service) {
      const text = "PTY Service is not available. Cannot spawn a task agent.";
      await callbackText(callback, text);
      return errorResult("SERVICE_UNAVAILABLE");
    }

    try {
      const params = paramsRecord(options as HandlerOptionsLike | undefined);
      const content = contentRecord(message);
      const text = messageText(message);
      const task = pickString(params, content, "task") ?? text;
      const explicitAgentType = pickString(params, content, "agentType");
      const agentType = (explicitAgentType ??
        (await service.resolveAgentType?.({
          task,
          workdir: pickString(params, content, "workdir"),
        })) ??
        "codex") as AgentType;
      const workdir = pickString(params, content, "workdir") ?? process.cwd();
      const memoryContent = pickString(params, content, "memoryContent");
      const approvalPreset = parseApproval(
        pickString(params, content, "approvalPreset"),
      );
      const keepAliveAfterComplete = pickBoolean(
        params,
        content,
        "keepAliveAfterComplete",
      );
      const label = pickString(params, content, "label") ?? task.slice(0, 80);

      const session = await service.spawnSession({
        agentType,
        workdir,
        initialTask: task,
        memoryContent,
        approvalPreset,
        metadata: {
          requestedType: explicitAgentType ?? agentType,
          messageId: message.id,
          roomId: message.roomId,
          worldId: message.worldId,
          userId: message.entityId,
          label,
          keepAliveAfterComplete,
        },
      });

      setCurrentSession(state, session);
      logger(runtime).info?.("Spawned acpx task agent", {
        sessionId: session.sessionId,
        agentType: session.agentType,
        workdir: session.workdir,
      });

      return {
        success: true,
        text: "",
        data: {
          sessionId: session.sessionId,
          agentType: session.agentType,
          workdir: session.workdir,
          status: session.status,
          label,
          suppressActionResultClipboard: true,
        },
      };
    } catch (error) {
      const messageTextValue = failureMessage(error);
      const code = isAuthError(error)
        ? "INVALID_CREDENTIALS"
        : messageTextValue;
      await callbackText(
        callback,
        isAuthError(error)
          ? "Invalid credentials for task agent."
          : `Failed to spawn agent: ${messageTextValue}`,
      );
      return { success: false, error: code };
    }
  },
} as Action & { suppressPostActionContinuation: true };

export const spawnTaskAgentAction = spawnAgentAction;

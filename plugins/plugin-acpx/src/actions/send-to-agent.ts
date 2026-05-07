import type { Action, ActionResult } from "@elizaos/core";
import {
  callbackText,
  contentRecord,
  errorResult,
  failureMessage,
  getAcpService,
  type HandlerOptionsLike,
  paramsRecord,
  pickString,
  resolveSession,
  validateHasSessions,
} from "./common.js";

export const sendToAgentAction: Action = {
  name: "SEND_TO_AGENT",
  similes: [
    "SEND_TO_CODING_AGENT",
    "MESSAGE_CODING_AGENT",
    "INPUT_TO_AGENT",
    "RESPOND_TO_AGENT",
    "TELL_CODING_AGENT",
    "MESSAGE_AGENT",
    "TELL_TASK_AGENT",
  ],
  description:
    "Send text input or key presses to a running task-agent session. Use it to respond to prompts, provide feedback, continue a task, or assign a fresh tracked task to an existing agent.",
  parameters: [
    {
      name: "sessionId",
      description: "Target task-agent session ID",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "input",
      description: "Text to send to the agent",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "task",
      description: "New task to assign to the agent",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "label",
      description: "Optional task label",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "keys",
      description: "Key sequence to send",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: validateHasSessions,
  handler: async (
    runtime,
    message,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const service = getAcpService(runtime);
    if (!service) {
      await callbackText(callback, "PTY Service is not available.");
      return errorResult("SERVICE_UNAVAILABLE");
    }

    try {
      const params = paramsRecord(options as HandlerOptionsLike | undefined);
      const content = contentRecord(message);
      const sessionId = pickString(params, content, "sessionId");
      const input = pickString(params, content, "input");
      const task = pickString(params, content, "task");
      const keys = pickString(params, content, "keys");
      const target = await resolveSession(service, sessionId, state);

      if (!target.session) {
        if (target.missingId) {
          const text = `Session ${target.missingId} not found.`;
          await callbackText(callback, text);
          return errorResult("SESSION_NOT_FOUND");
        }
        await callbackText(
          callback,
          "No active task-agent sessions. Spawn an agent first.",
        );
        return errorResult("NO_SESSION");
      }

      if (keys) {
        await service.sendKeysToSession(target.session.id, keys);
        await callbackText(callback, "Sent key sequence");
        return {
          success: true,
          text: "Sent key sequence",
          data: { sessionId: target.session.id, keys },
        };
      }

      const textInput = input ?? task;
      if (textInput) {
        await service.sendToSession(target.session.id, textInput);
        const text = task
          ? "Assigned new task to agent"
          : "Sent input to agent";
        await callbackText(callback, text);
        return {
          success: true,
          text,
          data: {
            sessionId: target.session.id,
            input: textInput,
            ...(task ? { task } : {}),
          },
        };
      }

      await callbackText(
        callback,
        "No input provided. Specify 'input', 'task', or 'keys' parameter.",
      );
      return errorResult("NO_INPUT");
    } catch (error) {
      const msg = failureMessage(error);
      await callbackText(callback, `Failed to send to agent: ${msg}`);
      return { success: false, error: msg };
    }
  },
};

export const sendToTaskAgentAction = sendToAgentAction;

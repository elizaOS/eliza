import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => false),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import { connectorAction } from "../src/actions/connector.js";
import { credentialsAction } from "../src/actions/credentials.js";
import { personalAssistantAction } from "../src/actions/owner-surfaces.js";
import { voiceCallAction } from "../src/actions/voice-call.js";

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-owner-guard-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "msg-owner-guard-test" as UUID,
    entityId: "non-owner" as UUID,
    roomId: "room-owner-guard-test" as UUID,
    content: { text },
  } as Memory;
}

async function callAction(
  action: Action,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await action.handler(
    runtime(),
    message("try an owner operation"),
    { values: {}, data: {}, text: "" } as State,
    { parameters } as HandlerOptions,
    async () => undefined,
  );
  return result as ActionResult;
}

describe("LifeOps owner action handler permissions", () => {
  beforeEach(() => {
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(false);
  });

  it.each([
    [
      credentialsAction,
      { action: "fill", url: "https://example.com" },
      "CREDENTIALS",
    ],
    [connectorAction, { action: "status", connector: "google" }, "CONNECTOR"],
    [voiceCallAction, { action: "dial", recipientKind: "owner" }, "VOICE_CALL"],
    [personalAssistantAction, { action: "book_travel" }, "PERSONAL_ASSISTANT"],
  ])("%s denies non-owner handler calls", async (action, parameters, name) => {
    const result = await callAction(action, parameters);

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      actionName: name,
      error: "PERMISSION_DENIED",
    });
  });
});

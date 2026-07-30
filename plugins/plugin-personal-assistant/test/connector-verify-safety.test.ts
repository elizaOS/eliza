/**
 * CONNECTOR verification is a read-only diagnostic boundary. Outbound test
 * messages use the normal draft/owner-approval path, including iMessage, so a
 * model cannot turn a health probe into an unapproved external side effect.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractActionParamsViaLlm: vi.fn(),
  hasLifeOpsAccess: vi.fn(async () => true),
  getConnectorRegistry: vi.fn(() => null),
  sendIMessage: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  extractActionParamsViaLlm: mocks.extractActionParamsViaLlm,
}));

vi.mock("../src/lifeops/access.js", () => ({
  hasLifeOpsAccess: mocks.hasLifeOpsAccess,
  INTERNAL_URL: new URL("http://127.0.0.1/"),
}));

vi.mock("../src/lifeops/connectors/index.js", () => ({
  getConnectorRegistry: mocks.getConnectorRegistry,
}));

vi.mock("../src/lifeops/service.js", () => ({
  LifeOpsService: class LifeOpsService {
    sendIMessage = mocks.sendIMessage;
  },
  LifeOpsServiceError: class LifeOpsServiceError extends Error {
    status = 500;
  },
}));

vi.mock("../src/platform/host.js", () => ({
  darwinUnavailableActionResult: vi.fn(),
  isDarwin: vi.fn(() => true),
}));

import { connectorAction } from "../src/actions/connector.js";
import { createIMessageConnectorContribution } from "../src/lifeops/connectors/imessage.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-connector-verify-safety" as UUID,
    getMessageConnectors: () => [],
    sendMessageToTarget: vi.fn(),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  mocks.extractActionParamsViaLlm.mockReset();
  mocks.hasLifeOpsAccess.mockReset().mockResolvedValue(true);
  mocks.getConnectorRegistry.mockReset().mockReturnValue(null);
  mocks.sendIMessage.mockReset();
});

describe("CONNECTOR verification send boundary", () => {
  it("rejects an outbound verification target before any connector dispatch", async () => {
    const runtime = makeRuntime();
    mocks.extractActionParamsViaLlm.mockResolvedValue({
      action: "verify",
      connector: "imessage",
      sendTarget: "+15551234567",
      sendMessage: "verification ping",
    });

    const result = await connectorAction.handler(
      runtime,
      {
        id: "message" as UUID,
        entityId: "owner" as UUID,
        roomId: "room" as UUID,
        content: { text: "send an iMessage verification ping" },
      } as Memory,
      { values: {}, data: {}, text: "" } as State,
      {
        parameters: {
          action: "verify",
          connector: "imessage",
          sendTarget: "+15551234567",
          sendMessage: "verification ping",
        },
      } as HandlerOptions,
      async () => undefined,
    );

    expect(result).toMatchObject({
      success: false,
      data: { error: "VERIFY_SEND_REQUIRES_APPROVAL" },
    });
    expect(runtime.sendMessageToTarget).not.toHaveBeenCalled();
    expect(mocks.sendIMessage).not.toHaveBeenCalled();
  });

  it("marks iMessage sends as owner-approval gated", () => {
    const contribution = createIMessageConnectorContribution(makeRuntime());
    expect(contribution.requiresApproval).toBe(true);
  });
});

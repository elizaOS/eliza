/**
 * Asserts owner-only action handlers deny when the LifeOps access gate is closed.
 * Deterministic, mocked access and extractor.
 */
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
  extractActionParamsViaLlm: vi.fn(async () => ({})),
  hasLifeOpsAccess: vi.fn(async () => false),
}));

vi.mock("@elizaos/agent", () => ({
  extractActionParamsViaLlm: mocks.extractActionParamsViaLlm,
  hasOwnerAccess: mocks.hasLifeOpsAccess,
}));

vi.mock("@elizaos/plugin-calendly", () => ({
  CalendlyAdapter: class CalendlyAdapter {},
  CalendlyError: class CalendlyError extends Error {},
  createCalendlySingleUseLink: vi.fn(),
  getCalendlyAvailability: vi.fn(),
  listCalendlyEventTypes: vi.fn(),
  listCalendlyScheduledEvents: vi.fn(),
  readCalendlyCredentialsFromEnv: vi.fn(() => null),
}));

vi.mock("@elizaos/plugin-phone/twilio", () => ({
  readTwilioCredentialsFromEnv: vi.fn(() => null),
  sendTwilioVoiceCall: vi.fn(),
}));

vi.mock("../src/lifeops/access.js", () => ({
  hasLifeOpsAccess: mocks.hasLifeOpsAccess,
  INTERNAL_URL: new URL("http://127.0.0.1/"),
}));

vi.mock("../src/lifeops/service.js", () => ({
  LifeOpsService: class LifeOpsService {},
  LifeOpsServiceError: class LifeOpsServiceError extends Error {},
}));

vi.mock("../src/lifeops/connectors/index.js", () => ({
  getConnectorRegistry: vi.fn(() => null),
}));

vi.mock("../src/platform/host.js", () => ({
  darwinUnavailableActionResult: vi.fn(() => ({
    success: false,
    data: { error: "DARWIN_UNAVAILABLE" },
  })),
  isDarwin: vi.fn(() => true),
}));

vi.mock("../src/actions/autofill.js", () => ({
  runAutofillHandler: vi.fn(),
}));

vi.mock("../src/actions/password-manager.js", () => ({
  runPasswordManagerHandler: vi.fn(),
}));

vi.mock("../src/actions/book-travel.js", () => ({
  runBookTravelHandler: vi.fn(),
}));

vi.mock("../src/actions/health.js", () => ({
  createOwnerHealthAction: vi.fn((args: { validate?: unknown }) => ({
    name: "OWNER_HEALTH",
    validate: args.validate,
    handler: vi.fn(),
  })),
  runHealthHandler: vi.fn(),
}));

vi.mock("../src/actions/lib/scheduling-handler.js", () => ({
  runSchedulingNegotiationHandler: vi.fn(),
}));

vi.mock("../src/actions/life.js", () => ({
  OWNER_OPERATION_CONTEXTS: ["tasks"],
  OWNER_OPERATION_ROLE_GATE: { minRole: "OWNER" },
  OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION: true,
  OWNER_OPERATION_TAGS: ["owner"],
  OWNER_OPERATION_VALIDATE: vi.fn(async () => true),
  runLifeOperationHandler: vi.fn(),
}));

vi.mock("../src/actions/money.js", () => ({
  MONEY_PARAMETERS: [],
  OWNER_FINANCE_SIMILES: [],
  runMoneyHandler: vi.fn(),
}));

vi.mock("../src/actions/schedule.js", () => ({
  runScheduleHandler: vi.fn(),
}));

vi.mock("../src/actions/screen-time.js", () => ({
  createOwnerScreenTimeAction: vi.fn((args: { validate?: unknown }) => ({
    name: "OWNER_SCREENTIME",
    validate: args.validate,
    handler: vi.fn(),
  })),
  runScreenTimeHandler: vi.fn(),
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: vi.fn(),
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
    mocks.hasLifeOpsAccess.mockReset().mockResolvedValue(false);
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

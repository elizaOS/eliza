import type { HandlerOptions, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  markInboxEntryRead: vi.fn(),
  createDefinition: vi.fn(),
}));

vi.mock("./lifeops-google-helpers.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1/"),
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent/actions/extract-params", () => ({
  extractActionParamsViaLlm: vi.fn(
    async (args: { existingParams: unknown }) => args.existingParams,
  ),
}));

vi.mock("../lifeops/service.js", () => {
  class FakeError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  class FakeLifeOpsService {
    markInboxEntryRead = serviceMocks.markInboxEntryRead;
    createDefinition = serviceMocks.createDefinition;
  }
  return {
    LifeOpsServiceError: FakeError,
    LifeOpsService: FakeLifeOpsService,
  };
});

async function runMutateAction(message: Memory, options?: HandlerOptions) {
  const { lifeOpsMutateAction } = await import("./lifeops-mutate.js");
  const handler = lifeOpsMutateAction.handler;
  if (!handler) {
    throw new Error("lifeOpsMutateAction handler missing");
  }
  return handler({} as never, message, undefined, options, undefined);
}

describe("lifeOpsMutateAction", () => {
  beforeEach(() => {
    serviceMocks.markInboxEntryRead.mockReset();
    serviceMocks.createDefinition.mockReset();
    serviceMocks.markInboxEntryRead.mockResolvedValue({
      id: "inbox-1",
      channel: "telegram",
      sender: {
        id: "sender-1",
        displayName: "Alice",
        email: null,
        avatarUrl: null,
      },
      subject: null,
      snippet: "read me",
      receivedAt: "2026-04-21T12:00:00.000Z",
      unread: false,
      deepLink: null,
      sourceRef: {
        channel: "telegram",
        externalId: "mem-1",
      },
      lastSeenAt: "2026-04-21T12:05:00.000Z",
    });
    serviceMocks.createDefinition.mockResolvedValue({
      definition: {
        id: "def-1",
        kind: "task",
        title: "Check passport renewal",
      },
      reminderPlan: null,
      performance: {},
    });
  });

  it("marks an inbox entry read through the LifeOps service", async () => {
    const result = await runMutateAction(
      { content: { text: "mark this as read" } } as Memory,
      {
        parameters: {
          subaction: "mark_read",
          inboxEntryId: "inbox-1",
        },
      },
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_MUTATE",
        subaction: "mark_read",
        message: {
          id: "inbox-1",
          unread: false,
        },
      },
    });
    expect(serviceMocks.markInboxEntryRead).toHaveBeenCalledWith("inbox-1");
  });

  it("requires inboxEntryId for mark_read", async () => {
    const result = await runMutateAction(
      { content: { text: "mark this as read" } } as Memory,
      {
        parameters: {
          subaction: "mark_read",
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      data: {
        actionName: "LIFEOPS_MUTATE",
        subaction: "mark_read",
        error: "MISSING_PARAMS",
      },
    });
  });

  it("creates a LifeOps reminder definition through the service", async () => {
    const cadence = {
      kind: "once",
      dueAt: "2026-05-01T16:00:00.000Z",
    };
    const result = await runMutateAction(
      { content: { text: "create reminder" } } as Memory,
      {
        parameters: {
          subaction: "reminder_create",
          definitionKind: "task",
          title: "Check passport renewal",
          cadence,
          timezone: "America/Los_Angeles",
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_MUTATE",
        subaction: "reminder_create",
        record: {
          definition: {
            id: "def-1",
            kind: "task",
            title: "Check passport renewal",
          },
        },
      },
    });
    expect(serviceMocks.createDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task",
        title: "Check passport renewal",
        cadence,
        timezone: "America/Los_Angeles",
      }),
    );
  });

  it("requires structured params for direct reminder_create", async () => {
    const result = await runMutateAction(
      { content: { text: "create reminder" } } as Memory,
      {
        parameters: { subaction: "reminder_create", title: "Missing cadence" },
      },
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        actionName: "LIFEOPS_MUTATE",
        subaction: "reminder_create",
        error: "MISSING_PARAMS",
        missing: ["definitionKind", "cadence"],
      },
    });
  });

  it("rejects when subaction is missing", async () => {
    const result = await runMutateAction(
      { content: { text: "" } } as Memory,
      undefined,
    );
    expect(result).toMatchObject({
      success: false,
      data: { error: "MISSING_SUBACTION" },
    });
  });

  it("flags missing required params for gmail_reply", async () => {
    const result = await runMutateAction(
      { content: { text: "send a reply" } } as Memory,
      { parameters: { subaction: "gmail_reply" } },
    );
    expect(result).toMatchObject({
      success: false,
      data: { subaction: "gmail_reply", error: "MISSING_PARAMS" },
    });
  });
});

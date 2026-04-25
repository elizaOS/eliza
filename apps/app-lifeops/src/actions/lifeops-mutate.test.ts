import type { Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lifeops-google-helpers.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1/"),
  hasLifeOpsAccess: vi.fn(async () => true),
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
  return {
    LifeOpsServiceError: FakeError,
    LifeOpsService: vi.fn().mockImplementation(() => ({})),
  };
});

describe("lifeOpsMutateAction", () => {
  it("returns NOT_IMPLEMENTED for mark_read (no service method yet)", async () => {
    const { lifeOpsMutateAction } = await import("./lifeops-mutate.js");
    const result = await lifeOpsMutateAction.handler!(
      {} as never,
      { content: { text: "mark this as read" } } as Memory,
      undefined,
      {
        parameters: {
          subaction: "mark_read",
          inboxEntryId: "inbox-1",
        },
      },
      undefined,
    );
    expect(result).toMatchObject({
      success: false,
      data: {
        actionName: "LIFEOPS_MUTATE",
        subaction: "mark_read",
        error: "NOT_IMPLEMENTED",
      },
    });
  });

  it("rejects when subaction is missing", async () => {
    const { lifeOpsMutateAction } = await import("./lifeops-mutate.js");
    const result = await lifeOpsMutateAction.handler!(
      {} as never,
      { content: { text: "" } } as Memory,
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({
      success: false,
      data: { error: "MISSING_SUBACTION" },
    });
  });

  it("flags missing required params for gmail_reply", async () => {
    const { lifeOpsMutateAction } = await import("./lifeops-mutate.js");
    const result = await lifeOpsMutateAction.handler!(
      {} as never,
      { content: { text: "send a reply" } } as Memory,
      undefined,
      { parameters: { subaction: "gmail_reply" } },
      undefined,
    );
    expect(result).toMatchObject({
      success: false,
      data: { subaction: "gmail_reply", error: "MISSING_PARAMS" },
    });
  });
});

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lifeops/service.js", () => ({
  LifeOpsService: class LifeOpsService {},
  LifeOpsServiceError: class LifeOpsServiceError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

const ROOM_ID = "00000000-0000-4000-8000-000000000001" as UUID;

function buildRuntime(scope: string | undefined): {
  runtime: IAgentRuntime;
  getRoom: ReturnType<typeof vi.fn>;
} {
  // Room metadata is extracted via `extractConversationMetadataFromRoom`,
  // which reads the ConversationMetadata out of `room.metadata.webConversation`.
  // A missing webConversation block models "no scope set" (home chat).
  const metadata =
    scope === undefined ? undefined : { webConversation: { scope } };
  const getRoom = vi.fn(async (roomId: string) => ({
    id: roomId,
    metadata,
  }));
  const runtime = { getRoom } as unknown as IAgentRuntime;
  return { runtime, getRoom };
}

function buildMessage(text: string): Memory {
  return {
    id: "11111111-1111-4000-8000-000000000001" as UUID,
    roomId: ROOM_ID,
    entityId: "22222222-2222-4000-8000-000000000001" as UUID,
    agentId: "33333333-3333-4000-8000-000000000001" as UUID,
    content: { text, source: "test" },
  } as Memory;
}

async function runValidate(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  const { lifeAction } = await import("./life.js");
  const { validate } = lifeAction;
  if (!validate) {
    throw new Error("lifeAction.validate is required for this suite");
  }
  return validate(runtime, message);
}

describe("lifeAction.validate — scope gating", () => {
  const reminderPrompt = "set an alarm for 7am";

  it("rejects on page-automations scope (Session 8/10 reproduction)", async () => {
    const { runtime } = buildRuntime("page-automations");
    const message = buildMessage(reminderPrompt);
    const result = await runValidate(runtime, message);
    expect(result).toBe(false);
  });

  // Cover every page-* scope in the server-side `VALID_SCOPES` allowlist
  // (`@elizaos/agent/api/conversation-metadata`) other than `page-lifeops`
  // itself. `isForeignPageScope` must reject all of these so the planner
  // sees a clean candidate set on each non-LifeOps surface.
  // (`page-automations` has its own explicit test above with the same
  // assertion shape; not duplicated here.)
  it.each([
    "page-apps",
    "page-browser",
    "page-character",
    "page-connectors",
    "page-phone",
    "page-plugins",
    "page-settings",
    "page-wallet",
  ])("rejects on foreign page scope %s", async (scope) => {
    const { runtime } = buildRuntime(scope);
    const message = buildMessage(reminderPrompt);
    const result = await runValidate(runtime, message);
    expect(result).toBe(false);
  });

  it("accepts on page-lifeops scope (LifeOps surface)", async () => {
    const { runtime } = buildRuntime("page-lifeops");
    const message = buildMessage(reminderPrompt);
    const result = await runValidate(runtime, message);
    expect(result).toBe(true);
  });

  it("accepts when no scope metadata is set (home chat / direct app-lifeops room)", async () => {
    const { runtime } = buildRuntime(undefined);
    const message = buildMessage(reminderPrompt);
    const result = await runValidate(runtime, message);
    expect(result).toBe(true);
  });

  it("accepts on non-page scope (e.g. automation-draft)", async () => {
    const { runtime } = buildRuntime("automation-draft");
    const message = buildMessage(reminderPrompt);
    const result = await runValidate(runtime, message);
    expect(result).toBe(true);
  });

  it("rejects coding-task text even on page-lifeops scope (text filter short-circuits before scope check)", async () => {
    const { runtime, getRoom } = buildRuntime("page-lifeops");
    const message = buildMessage("build a dashboard component");
    const result = await runValidate(runtime, message);
    expect(result).toBe(false);
    expect(getRoom).not.toHaveBeenCalled();
  });
});

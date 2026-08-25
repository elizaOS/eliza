/**
 * Callback-query identity failure. Proves a configured-owner
 * `getEntityById` miss or storage error is acknowledged to Telegram with a
 * user-visible alert instead of leaving the button spinner running, and that
 * the turn is not dispatched. Real core identity resolution; Telegraf is mocked.
 */
import { encodeReplyCallback, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

// The shared vitest setup stubs `getConfiguredOwnerEntityIds` to `[]`, which
// would hide the canonical-owner store path this file exists to cover.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return { ...actual };
});

const OWNER_ENTITY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeCallbackManager(runtimeOverrides: Record<string, unknown> = {}) {
  const handleMessage = vi.fn(async () => undefined);
  const ensureConnection = vi.fn(async () => undefined);
  const reportError = vi.fn();
  const runtime = {
    agentId: "agent-1",
    messageService: { handleMessage },
    ensureConnection,
    reportError,
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY_ID : undefined,
    ...runtimeOverrides,
  };
  const bot = { telegram: { sendMessage: vi.fn(), sendChatAction: vi.fn() } };
  return {
    manager: new MessageManager(
      bot as never,
      runtime as unknown as IAgentRuntime,
    ),
    handleMessage,
    ensureConnection,
    reportError,
    runtime,
  };
}

function callbackCtx() {
  const data = encodeReplyCallback("continue");
  if (!data) {
    throw new Error("encodeReplyCallback returned null");
  }
  return {
    callbackQuery: {
      id: "cbq-identity",
      data,
      message: {
        message_id: 77,
        chat: { id: 123, type: "private" },
        date: 1_700_000_000,
      },
    },
    from: {
      id: 42,
      first_name: "Ada",
      username: "ada",
      is_bot: false,
    },
    chat: { id: 123, type: "private" },
    answerCbQuery: vi.fn(async () => undefined),
  };
}

describe("handleCallbackQuery identity failure", () => {
  it("acknowledges and fails closed when getEntityById rejects", async () => {
    const getEntityById = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const { manager, handleMessage, reportError } = makeCallbackManager({
      getEntityById,
    });
    const ctx = callbackCtx();

    await expect(
      manager.handleCallbackQuery(ctx as never),
    ).resolves.toBeUndefined();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(
      "Could not verify your identity. Try again.",
      { show_alert: true },
    );
    expect(reportError).toHaveBeenCalledWith(
      "telegram:callback-identity",
      expect.objectContaining({ message: "store unavailable" }),
      expect.objectContaining({
        telegramUserId: "42",
      }),
    );
  });

  it("acknowledges and fails closed when getEntityById is absent", async () => {
    const { manager, handleMessage, reportError } = makeCallbackManager();
    const ctx = callbackCtx();

    await expect(
      manager.handleCallbackQuery(ctx as never),
    ).resolves.toBeUndefined();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(
      "Could not verify your identity. Try again.",
      { show_alert: true },
    );
    expect(reportError).toHaveBeenCalledWith(
      "telegram:callback-identity",
      expect.objectContaining({ code: "TELEGRAM_IDENTITY_NOT_READY" }),
      expect.objectContaining({
        telegramUserId: "42",
      }),
    );
  });
});

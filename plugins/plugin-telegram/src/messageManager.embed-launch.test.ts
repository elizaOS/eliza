/**
 * Unit tests for the embedded-app (Mini App) launch button: an OWNER sender gets
 * a `web_app` button at the platform-tagged https `/embed` url, an http url is
 * never emitted, and non-elevated senders or an unconfigured url get nothing.
 * `hasRoleAccess` is mocked to control sender trust.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { InlineKeyboardButton } from "@telegraf/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The embedded-app (Mini App) launch button is role-gated through the agent
// role model (`hasRoleAccess`, resolved via `resolveTelegramSenderAuth`). Mock
// it so each test controls the sender's resolved trust level without standing
// up a full world/role graph. `vi.hoisted` is required because `vi.mock`
// factories are hoisted above imports. (#9947)
const { hasRoleAccess } = vi.hoisted(() => ({
  hasRoleAccess: vi.fn(async () => true),
}));
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return { ...actual, hasRoleAccess };
});

import { MessageManager } from "./messageManager";

const HTTPS_EMBED_URL = "https://app.eliza.example/embed";
const HTTPS_TELEGRAM_EMBED_URL =
  "https://app.eliza.example/embed?platform=telegram";

function setup(settings: Record<string, string> = {}) {
  const runtime = {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const manager = new MessageManager(
    { telegram: {} } as never,
    runtime as never,
  );

  const sendMessage = vi.fn(async (chatId: number | string, text: string) => ({
    message_id: 9,
    date: 1_700_000_000,
    text,
    chat: { id: chatId, type: "private" },
  }));
  const senders = {
    sendChatAction: vi.fn(async () => undefined),
    sendMessage,
  };
  const ctx = {
    chat: { id: 123 },
    from: { id: 555, username: "tester" },
    telegram: senders,
  } as never;
  return { manager, ctx, sendMessage };
}

/** Pull the reply_markup keyboard from the last `sendMessage` call. */
function lastKeyboard(
  sendMessage: ReturnType<typeof vi.fn>,
): InlineKeyboardButton[][] {
  const calls = sendMessage.mock.calls;
  const last = calls[calls.length - 1];
  const options = last?.[2] as
    | { reply_markup?: { inline_keyboard?: InlineKeyboardButton[][] } }
    | undefined;
  return options?.reply_markup?.inline_keyboard ?? [];
}

function webAppButtons(
  keyboard: InlineKeyboardButton[][],
): Array<{ text: string; web_app: { url: string } }> {
  return keyboard
    .flat()
    .filter(
      (button): button is { text: string; web_app: { url: string } } =>
        typeof button === "object" && button !== null && "web_app" in button,
    );
}

describe("Telegram embedded-app launch button (#9947)", () => {
  beforeEach(() => {
    hasRoleAccess.mockReset();
    hasRoleAccess.mockResolvedValue(true);
  });

  it("emits a web_app button with the platform-tagged https /embed url for an OWNER sender", async () => {
    const { manager, ctx, sendMessage } = setup({
      ELIZA_EMBED_URL: HTTPS_EMBED_URL,
    });

    await manager.sendMessageInChunks(ctx, { text: "hello" } as never);

    const buttons = webAppButtons(lastKeyboard(sendMessage));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].web_app.url).toBe(HTTPS_TELEGRAM_EMBED_URL);
    expect(buttons[0].text.length).toBeGreaterThan(0);
  });

  it("derives <web base>/embed from ELIZA_APP_URL", async () => {
    const { manager, ctx, sendMessage } = setup({
      ELIZA_APP_URL: "https://app.eliza.example/",
    });

    await manager.sendMessageInChunks(ctx, { text: "hello" } as never);

    const buttons = webAppButtons(lastKeyboard(sendMessage));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].web_app.url).toBe(HTTPS_TELEGRAM_EMBED_URL);
  });

  it("emits NO web_app button for a non-elevated sender", async () => {
    hasRoleAccess.mockResolvedValue(false);
    const { manager, ctx, sendMessage } = setup({
      ELIZA_EMBED_URL: HTTPS_EMBED_URL,
    });

    await manager.sendMessageInChunks(ctx, { text: "hello" } as never);

    expect(webAppButtons(lastKeyboard(sendMessage))).toHaveLength(0);
  });

  it("guards https: an http embed url is never emitted, even to an OWNER", async () => {
    const { manager, ctx, sendMessage } = setup({
      ELIZA_EMBED_URL: "http://insecure.example/embed",
    });

    await manager.sendMessageInChunks(ctx, { text: "hello" } as never);

    expect(webAppButtons(lastKeyboard(sendMessage))).toHaveLength(0);
  });

  it("emits nothing when no embed url is configured", async () => {
    const { manager, ctx, sendMessage } = setup();

    await manager.sendMessageInChunks(ctx, { text: "hello" } as never);

    expect(webAppButtons(lastKeyboard(sendMessage))).toHaveLength(0);
  });
});

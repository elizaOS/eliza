import type { IAgentRuntime } from "@elizaos/core";
import type { ConnectorSenderAuth } from "@elizaos/plugin-commands";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `/app` resolves the sender's trust level via the agent role model. Mock the
// resolver so each test controls the resolved auth without a world/role graph.
const { resolveTelegramSenderAuth } = vi.hoisted(() => ({
  resolveTelegramSenderAuth: vi.fn(),
}));
vi.mock("./command-registration", () => ({ resolveTelegramSenderAuth }));

import {
  buildTelegramEmbedLaunchButton,
  EMBED_LAUNCH_COMMAND,
  registerTelegramEmbedLaunchCommand,
  resolveEmbedLaunchUrl,
} from "./embed-launch";

const HTTPS_URL = "https://app.elizacloud.ai/embed";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

const elevated: ConnectorSenderAuth = {
  isAuthorized: false,
  isElevated: true,
  senderName: "admin",
};
const owner: ConnectorSenderAuth = {
  isAuthorized: true,
  isElevated: true,
  senderName: "owner",
};
const plain: ConnectorSenderAuth = {
  isAuthorized: false,
  isElevated: false,
  senderName: "user",
};

beforeEach(() => {
  resolveTelegramSenderAuth.mockReset();
});

describe("resolveEmbedLaunchUrl", () => {
  it("prefers an explicit HTTPS TELEGRAM_MINI_APP_URL", () => {
    const runtime = makeRuntime({ TELEGRAM_MINI_APP_URL: HTTPS_URL });
    expect(resolveEmbedLaunchUrl(runtime)).toBe(HTTPS_URL);
  });

  it("derives /embed from the public app URL", () => {
    const runtime = makeRuntime({
      ELIZA_PUBLIC_URL: "https://app.elizacloud.ai/",
    });
    expect(resolveEmbedLaunchUrl(runtime)).toBe(HTTPS_URL);
  });

  it("returns null for a non-HTTPS or unset URL", () => {
    expect(resolveEmbedLaunchUrl(makeRuntime())).toBeNull();
    expect(
      resolveEmbedLaunchUrl(
        makeRuntime({ ELIZA_PUBLIC_URL: "http://localhost" }),
      ),
    ).toBeNull();
  });
});

describe("buildTelegramEmbedLaunchButton", () => {
  it("emits a web_app button for an admin sender", () => {
    const rows = buildTelegramEmbedLaunchButton({
      sender: elevated,
      url: HTTPS_URL,
    });
    expect(rows).toEqual([
      [{ text: expect.any(String), web_app: { url: HTTPS_URL } }],
    ]);
  });

  it("emits a web_app button for an owner sender", () => {
    const rows = buildTelegramEmbedLaunchButton({
      sender: owner,
      url: HTTPS_URL,
    });
    expect(rows?.[0]?.[0]).toMatchObject({ web_app: { url: HTTPS_URL } });
  });

  it("fails closed (null) for a non-elevated sender", () => {
    expect(
      buildTelegramEmbedLaunchButton({ sender: plain, url: HTTPS_URL }),
    ).toBeNull();
  });

  it("returns null when no HTTPS url is configured", () => {
    expect(
      buildTelegramEmbedLaunchButton({ sender: owner, url: null }),
    ).toBeNull();
  });
});

describe("registerTelegramEmbedLaunchCommand", () => {
  function setup(
    sender: ConnectorSenderAuth,
    settings: Record<string, string>,
  ) {
    resolveTelegramSenderAuth.mockResolvedValue(sender);
    let handler: ((ctx: unknown) => Promise<void>) | undefined;
    const bot = {
      command: (name: string, fn: (ctx: unknown) => Promise<void>) => {
        expect(name).toBe(EMBED_LAUNCH_COMMAND);
        handler = fn;
      },
    } as never;
    registerTelegramEmbedLaunchCommand(bot, makeRuntime(settings), "default");
    const reply = vi.fn(async () => undefined);
    return { invoke: () => handler?.({ reply }), reply };
  }

  it("replies with a web_app button for an elevated sender", async () => {
    const { invoke, reply } = setup(elevated, {
      TELEGRAM_MINI_APP_URL: HTTPS_URL,
    });
    await invoke();
    expect(reply).toHaveBeenCalledTimes(1);
    const [, opts] = reply.mock.calls[0] as [string, { reply_markup: unknown }];
    expect(JSON.stringify(opts.reply_markup)).toContain(HTTPS_URL);
    expect(JSON.stringify(opts.reply_markup)).toContain("web_app");
  });

  it("refuses (no button) for a non-elevated sender", async () => {
    const { invoke, reply } = setup(plain, {
      TELEGRAM_MINI_APP_URL: HTTPS_URL,
    });
    await invoke();
    expect(reply).toHaveBeenCalledTimes(1);
    const [, opts] = reply.mock.calls[0] as [
      string,
      { reply_markup?: unknown } | undefined,
    ];
    expect(opts?.reply_markup).toBeUndefined();
  });
});

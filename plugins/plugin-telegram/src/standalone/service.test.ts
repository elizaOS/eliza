/**
 * Exercises standalone Telegram gating and lifecycle against a mocked Telegraf
 * client while retaining the production shared poller-lock implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub Telegraf so the gate/lifecycle can be exercised without any network.
const { FakeTelegraf, launchMock, stopMock, constructed } = vi.hoisted(() => {
  const constructed: Array<{ token: string }> = [];
  const launchMock = vi.fn(() => new Promise<void>(() => {}));
  const stopMock = vi.fn();
  class FakeTelegraf {
    launch = launchMock;
    constructor(public token: string) {
      constructed.push({ token });
    }
    on() {}
    catch() {}
    stop(...args: unknown[]) {
      stopMock(...args);
    }
  }
  return { FakeTelegraf, launchMock, stopMock, constructed };
});

vi.mock("telegraf", () => ({ Telegraf: FakeTelegraf }));

import {
  claimTelegramPollerToken,
  releaseTelegramPollerToken,
} from "../poller-lock";
import { shouldStartTelegramStandaloneBot } from "./policy";
import { TelegramStandaloneService } from "./service";

// Minimal runtime — the service only touches getService() at stop time.
function fakeRuntime(
  plugins: string[] = [],
): Parameters<typeof TelegramStandaloneService.start>[0] {
  return {
    agentId: "agent-standalone",
    plugins: plugins.map((name) => ({
      name,
      passiveConnectorsByDefault: name === "@elizaos/plugin-personal-assistant",
    })),
    getService: vi.fn(() => null),
    reportError: vi.fn(),
  } as unknown as Parameters<typeof TelegramStandaloneService.start>[0];
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  constructed.length = 0;
  launchMock.mockClear();
  stopMock.mockClear();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("shouldStartTelegramStandaloneBot (gate truth table)", () => {
  it("is true for a non-LifeOps runtime when the standalone flag is set", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        ELIZA_TELEGRAM_STANDALONE_BOT: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("is false when passive connectors are off but the flag is unset", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("is true only when passive connectors are off AND the flag is truthy", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
        ELIZA_TELEGRAM_STANDALONE_BOT: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("is false when the resolved runtime loads LifeOps", () => {
    expect(
      shouldStartTelegramStandaloneBot(
        { ELIZA_TELEGRAM_STANDALONE_BOT: "true" } as NodeJS.ProcessEnv,
        fakeRuntime(["@elizaos/plugin-personal-assistant"]),
      ),
    ).toBe(false);
  });
});

describe("TelegramStandaloneService lifecycle", () => {
  it("launches for a plain runtime with the standalone flag", async () => {
    delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "1";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const service = await TelegramStandaloneService.start(fakeRuntime());

    expect(constructed).toEqual([{ token: "test-token" }]);
    expect(launchMock).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("no-ops when LifeOps owns passive Telegram, even with the flag set", async () => {
    delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "1";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const service = await TelegramStandaloneService.start(
      fakeRuntime(["@elizaos/plugin-personal-assistant"]),
    );

    expect(constructed).toHaveLength(0);
    expect(launchMock).not.toHaveBeenCalled();
    await service.stop();
  });

  it("launches a single poller when the gate is on and a token is present", async () => {
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "1";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const service = await TelegramStandaloneService.start(fakeRuntime());

    expect(constructed).toEqual([{ token: "test-token" }]);
    expect(launchMock).toHaveBeenCalledOnce();
    expect(launchMock.mock.calls[0][0]).toMatchObject({
      dropPendingUpdates: false,
      allowedUpdates: ["message", "message_reaction"],
    });

    await service.stop();
    expect(stopMock).toHaveBeenCalledWith("service-stop");
  });

  it("observes full-mode ownership through the shared lock and refuses a second poller", async () => {
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "1";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const activeBot = { stop: vi.fn() } as never;
    claimTelegramPollerToken("test-token", {
      bot: activeBot,
      mode: "full",
      ownerId: "agent-full",
      accountId: "default",
    });

    const error = await TelegramStandaloneService.start(fakeRuntime()).catch(
      (cause: unknown) => cause,
    );
    expect(launchMock).not.toHaveBeenCalled();
    releaseTelegramPollerToken("test-token", activeBot);
    expect(error).toMatchObject({
      code: "TELEGRAM_STANDALONE_SETUP_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(/already has an active full poller/i),
      }),
    });
  });

  it("stands down under the gate when no bot token is configured", async () => {
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "1";
    delete process.env.TELEGRAM_BOT_TOKEN;

    const service = await TelegramStandaloneService.start(fakeRuntime());

    expect(constructed).toHaveLength(0);
    expect(launchMock).not.toHaveBeenCalled();
    await service.stop();
  });
});

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

import { shouldStartTelegramStandaloneBot, TelegramStandaloneService } from "./index";

// Minimal runtime — the service only touches getService() at stop time.
function fakeRuntime(): Parameters<typeof TelegramStandaloneService.start>[0] {
  return {
    getService: vi.fn(() => null),
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
  it("is false by default (passive connectors on) even with the flag set", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        ELIZA_TELEGRAM_STANDALONE_BOT: "1",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("is false when passive connectors are off but the flag is unset", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("is true only when passive connectors are off AND the flag is truthy", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
        ELIZA_TELEGRAM_STANDALONE_BOT: "true",
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe("TelegramStandaloneService lifecycle", () => {
  it("no-ops (no poller) when the gate is off, even with a token present", async () => {
    delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "1";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const service = await TelegramStandaloneService.start(fakeRuntime());

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

    await service.stop();
    expect(stopMock).toHaveBeenCalledWith("service-stop");
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

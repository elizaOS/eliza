/**
 * Unit tests for `TelegramService.launchPollerSupervised` — the supervised
 * launch that replaces `await bot.launch()`. Telegraf v4's `bot.launch()`
 * resolves only when polling stops, so awaiting it for completion strands every
 * post-launch step (dedup registration, `setMyCommands`, shutdown handlers).
 * These tests drive a controllable fake Telegraf bot (its `launch(config,
 * onLaunch)` deferred is resolved/rejected by the test) to prove: the connect
 * signal settles the returned promise so the caller proceeds; a post-connect
 * poll failure self-heals with bounded, backed-off relaunches; and a newer
 * runtime taking over the token cancels the loser's relaunch. Runtime, timers,
 * and `@elizaos/core` (logger/Service) are mocked.
 */
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramService } from "./service";

const CONFLICT = "409: Conflict: terminated by other getUpdates request";

type SupervisedLaunch = (
  bot: unknown,
  botToken: string | null | undefined,
  accountId: string,
) => Promise<void>;

function callLaunch(
  service: TelegramService,
  bot: unknown,
  botToken: string | null,
  accountId: string,
): Promise<void> {
  return (
    service as unknown as { launchPollerSupervised: SupervisedLaunch }
  ).launchPollerSupervised(bot, botToken, accountId);
}

interface LaunchCall {
  config: { dropPendingUpdates?: boolean; allowedUpdates?: string[] };
  onLaunch: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function makeBot() {
  const calls: LaunchCall[] = [];
  const bot = {
    launch: vi.fn(
      (config: LaunchCall["config"], onLaunch: () => void): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          calls.push({ config, onLaunch, resolve, reject });
        }),
    ),
    stop: vi.fn(),
  };
  return { bot, calls };
}

function makeService() {
  const runtime = { agentId: "agent-test", reportError: vi.fn() };
  const service = Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    { runtime },
  );
  return { service, runtime };
}

// Flush the microtask that runs the launch promise's rejection handler before
// its backoff `setTimeout` is scheduled.
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("TelegramService.launchPollerSupervised", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves on the connect signal (unblocking the post-launch path) with drop-pending polling", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();

    const launched = callLaunch(service, bot, "tok-connect", "acct");
    // The poll loop is still running (launch promise stays pending); the caller
    // must proceed off the connect callback, not off loop completion.
    expect(bot.launch).toHaveBeenCalledTimes(1);
    expect(calls[0].config).toEqual({
      dropPendingUpdates: true,
      allowedUpdates: ["message", "message_reaction", "callback_query"],
    });

    calls[0].onLaunch();
    await expect(launched).resolves.toBeUndefined();
  });

  it("self-heals a post-connect poll failure with a bounded, backed-off relaunch and then gives up", async () => {
    const { bot, calls } = makeBot();
    const { service, runtime } = makeService();

    const launched = callLaunch(service, bot, "tok-heal", "acct");
    calls[0].onLaunch();
    await launched;

    // Persistent conflict on every attempt: backoff doubles (2^n s) capped at
    // 30s, and each attempt reuses the same bot instance (no re-registration of
    // handlers). Five relaunches → six launches total.
    const backoffsMs = [2000, 4000, 8000, 16000, 30000];
    for (let i = 0; i < backoffsMs.length; i++) {
      calls[i].reject(new Error(CONFLICT));
      await flushMicrotasks();
      expect(runtime.reportError).toHaveBeenCalledWith(
        "telegram:poll",
        expect.any(Error),
        expect.objectContaining({ accountId: "acct" }),
      );
      await vi.advanceTimersByTimeAsync(backoffsMs[i]);
      expect(bot.launch).toHaveBeenCalledTimes(i + 2);
    }

    // Sixth failure exceeds the relaunch budget: give up, do not relaunch.
    calls[5].reject(new Error(CONFLICT));
    await flushMicrotasks();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ maxPollRelaunches: 5 }),
      expect.stringContaining("gave up"),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.launch).toHaveBeenCalledTimes(6);
    expect(runtime.reportError).toHaveBeenCalledTimes(6);
  });

  it("does not relaunch after a newer runtime takes over the bot token", async () => {
    const first = makeBot();
    const second = makeBot();
    const { service } = makeService();

    const firstLaunched = callLaunch(
      service,
      first.bot,
      "tok-takeover",
      "acct",
    );
    first.calls[0].onLaunch();
    await firstLaunched;

    // A newer runtime launches on the same token and connects: its connect
    // registers it as the active poller, superseding the first.
    const secondLaunched = callLaunch(
      service,
      second.bot,
      "tok-takeover",
      "acct",
    );
    second.calls[0].onLaunch();
    await secondLaunched;

    // The first poller's loop now dies. Because it no longer owns the token,
    // the failure is surfaced but no relaunch is scheduled.
    first.calls[0].reject(new Error(CONFLICT));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(first.bot.launch).toHaveBeenCalledTimes(1);
    expect(second.bot.launch).toHaveBeenCalledTimes(1);
  });
});

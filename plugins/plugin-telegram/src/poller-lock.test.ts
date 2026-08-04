/**
 * Unit coverage for Telegram poller ownership. The lock crosses plugin modes
 * through process-global state, so these tests pin the privacy invariant
 * (fingerprinted keys, no bot instances in global records) and the reclaim
 * boundary between dead/stale claims and live incumbents.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimTelegramPollerToken,
  getTelegramPollerClaim,
  listTelegramPollerHealth,
  markTelegramPollerConnected,
  markTelegramPollerError,
  markTelegramPollerTerminated,
  markTelegramPollerUpdate,
  releaseTelegramPollerToken,
} from "./poller-lock";

const LOCKS_KEY = Symbol.for("elizaos.telegram.pollerLocks");
const LEGACY_LOCKS_KEY = "__elizaosTelegramPollerLocks";

function makeBot() {
  return { stop: vi.fn() } as never;
}

function fingerprint(token: string): string {
  return `bot:${createHash("sha256").update(token).digest("hex")}`;
}

function globalLocks(): Map<string, unknown> {
  return (globalThis as Record<PropertyKey, unknown>)[LOCKS_KEY] as Map<
    string,
    unknown
  >;
}

afterEach(() => {
  vi.useRealTimers();
  globalLocks()?.clear();
  delete (globalThis as Record<string, unknown>)[LEGACY_LOCKS_KEY];
});

describe("Telegram poller lock privacy", () => {
  it("stores claims under credential fingerprints without plaintext tokens or bot instances", () => {
    const token = "123456:plaintext-secret";
    const bot = makeBot();

    claimTelegramPollerToken(token, {
      bot,
      mode: "full",
      ownerId: "agent-a",
      accountId: "default",
    });

    const locks = globalLocks();
    expect(Array.from(locks.keys())).toEqual([fingerprint(token)]);
    expect(Array.from(locks.keys()).join(" ")).not.toContain(token);
    expect(JSON.stringify(Array.from(locks.values()))).not.toContain(token);
    expect(Array.from(locks.values())).not.toContain(bot);

    const claim = getTelegramPollerClaim(token);
    expect(claim?.bot).toBe(bot);
    expect(listTelegramPollerHealth()).toEqual([
      expect.not.objectContaining({ bot }),
    ]);
  });

  it("redacts the bot token before persisting poller errors", () => {
    const token = "123456:plaintext-secret";
    const bot = makeBot();
    claimTelegramPollerToken(token, {
      bot,
      mode: "full",
      ownerId: "agent-a",
      accountId: "default",
    });

    markTelegramPollerError(
      token,
      bot,
      new Error(
        `request failed for https://api.telegram.org/bot${token}/getUpdates with token ${token}`,
      ),
    );

    expect(getTelegramPollerClaim(token)?.lastError).toBe(
      "request failed for https://api.telegram.org/bot[REDACTED]/getUpdates with token [REDACTED]",
    );
  });

  it("deletes the legacy plaintext-token global map when the shared lock initializes", () => {
    (globalThis as Record<string, unknown>)[LEGACY_LOCKS_KEY] = new Map([
      ["123456:plaintext-secret", { leaked: true }],
    ]);

    claimTelegramPollerToken("123456:plaintext-secret", {
      bot: makeBot(),
      mode: "full",
      ownerId: "agent-a",
      accountId: "default",
    });

    expect(
      (globalThis as Record<string, unknown>)[LEGACY_LOCKS_KEY],
    ).toBeUndefined();
  });
});

describe("Telegram poller lock reclaim", () => {
  it("preserves a known disconnected owner as a hard failure", () => {
    const token = "200000:starting-owner";
    const oldBot = makeBot();
    const newBot = makeBot();
    claimTelegramPollerToken(token, {
      bot: oldBot,
      mode: "full",
      ownerId: "agent-old",
      accountId: "default",
    });
    markTelegramPollerError(token, oldBot, new Error("poller stopped"));

    expect(() =>
      claimTelegramPollerToken(token, {
        bot: newBot,
        mode: "standalone",
        ownerId: "agent-new",
        accountId: "default",
      }),
    ).toThrow(/already has an active full poller/i);
  });

  it("reclaims a claim only after an explicit terminal transition", () => {
    const token = "200000:terminal-owner";
    const oldBot = makeBot();
    const newBot = makeBot();
    claimTelegramPollerToken(token, {
      bot: oldBot,
      mode: "full",
      ownerId: "agent-old",
      accountId: "default",
    });
    markTelegramPollerConnected(token, oldBot);
    markTelegramPollerTerminated(token, oldBot, new Error("poller gave up"));

    claimTelegramPollerToken(token, {
      bot: newBot,
      mode: "standalone",
      ownerId: "agent-new",
      accountId: "default",
    });

    expect(getTelegramPollerClaim(token)).toEqual(
      expect.objectContaining({
        bot: newBot,
        mode: "standalone",
        ownerId: "agent-new",
      }),
    );
  });

  it("keeps a connected owner live even when no updates arrive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const token = "200000:live-owner";
    const oldBot = makeBot();
    const newBot = makeBot();
    claimTelegramPollerToken(token, {
      bot: oldBot,
      mode: "full",
      ownerId: "agent-old",
      accountId: "default",
    });
    markTelegramPollerConnected(token, oldBot);

    vi.setSystemTime(1_000_000 + 24 * 60 * 60 * 1000);
    markTelegramPollerUpdate(token, oldBot);
    vi.setSystemTime(1_000_000 + 48 * 60 * 60 * 1000);

    expect(() =>
      claimTelegramPollerToken(token, {
        bot: newBot,
        mode: "standalone",
        ownerId: "agent-new",
        accountId: "default",
      }),
    ).toThrow(/already has an active full poller/i);

    releaseTelegramPollerToken(token, oldBot);
  });
});

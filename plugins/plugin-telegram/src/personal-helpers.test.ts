/**
 * Coverage for Telegram personal (MTProto user-account) helpers — pure
 * config predicates used by the owner-binding gate. No live Telegram API.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  isTelegramPersonalEnabled,
  listPersonalTelegramAccounts,
  normalizeTelegramAccountId,
  telegramPersonalExternalId,
} from "./accounts.ts";

function runtime(accounts?: Record<string, unknown>): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { settings: { telegram: { accounts } } },
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("normalizeTelegramAccountId", () => {
  it("defaults empty/null/blank to default", () => {
    expect(normalizeTelegramAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeTelegramAccountId(null)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeTelegramAccountId("")).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeTelegramAccountId("   ")).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("trims and preserves a non-empty id", () => {
    expect(normalizeTelegramAccountId("  acct-a  ")).toBe("acct-a");
    expect(normalizeTelegramAccountId("default")).toBe("default");
  });
});

describe("isTelegramPersonalEnabled", () => {
  it("returns false when no personal block exists", () => {
    expect(isTelegramPersonalEnabled(makeAccount({}))).toBe(false);
    expect(
      isTelegramPersonalEnabled(
        makeAccount({ personal: { enabled: false, phone: "+1555" } }),
      ),
    ).toBe(false);
  });

  it("returns true when phone or session is present and not disabled", () => {
    expect(
      isTelegramPersonalEnabled(
        makeAccount({ personal: { phone: "+15551234567" } }),
      ),
    ).toBe(true);
    expect(
      isTelegramPersonalEnabled(
        makeAccount({ personal: { session: "sess_abc" } }),
      ),
    ).toBe(true);
    expect(
      isTelegramPersonalEnabled(
        makeAccount({ personal: { phone: "  ", session: "x" } }),
      ),
    ).toBe(true);
  });

  it("returns false when personal has no phone or session", () => {
    expect(isTelegramPersonalEnabled(makeAccount({ personal: {} }))).toBe(
      false,
    );
    expect(
      isTelegramPersonalEnabled(makeAccount({ personal: { appId: "123" } })),
    ).toBe(false);
  });
});

function makeAccount(config: Record<string, unknown>) {
  return { config } as unknown as Parameters<
    typeof isTelegramPersonalEnabled
  >[0];
}

describe("telegramPersonalExternalId", () => {
  it("derives tg-user:<phone> when phone is present", () => {
    expect(
      telegramPersonalExternalId(
        makeAccount({ personal: { phone: "+15551234567" } }),
      ),
    ).toBe("tg-user:+15551234567");
  });

  it("returns undefined when no phone is configured", () => {
    expect(
      telegramPersonalExternalId(
        makeAccount({ personal: { session: "sess" } }),
      ),
    ).toBeUndefined();
    expect(
      telegramPersonalExternalId(makeAccount({ personal: {} })),
    ).toBeUndefined();
    expect(telegramPersonalExternalId(makeAccount({}))).toBeUndefined();
  });

  it("trims whitespace from phone", () => {
    expect(
      telegramPersonalExternalId(
        makeAccount({ personal: { phone: "  +1555  " } }),
      ),
    ).toBe("tg-user:+1555");
  });
});

describe("listPersonalTelegramAccounts", () => {
  it("returns only accounts with a usable personal identity", () => {
    const rt = runtime({
      alice: { personal: { phone: "+111" } },
      bob: { personal: { enabled: false, phone: "+222" } },
      carol: { personal: { session: "sess" } },
      dave: {},
    });
    const list = listPersonalTelegramAccounts(rt);
    const ids = list.map((a) => a.accountId);
    expect(ids).toContain("alice");
    expect(ids).toContain("carol");
    expect(ids).not.toContain("bob");
    expect(ids).not.toContain("dave");
  });

  it("returns empty when no accounts declare personal", () => {
    const rt = runtime({ x: {}, y: { personal: {} } });
    expect(listPersonalTelegramAccounts(rt)).toHaveLength(0);
  });
});

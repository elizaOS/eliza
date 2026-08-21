/**
 * Unit coverage for `resolveTelegramAppCredentials` — the trust-domain MTProto
 * app-credential precedence (per-account config → deployment settings →
 * user-owned provisioning). Deterministic: a plain fake runtime whose
 * `getSetting` reads a map, no network and no real model. The resolver is pure,
 * so it runs under the package's global core stub.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { resolveTelegramAppCredentials } from "./account-setup-routes.ts";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

describe("resolveTelegramAppCredentials", () => {
  it("prefers per-account configured creds (string appId)", () => {
    const creds = resolveTelegramAppCredentials(makeRuntime(), {
      appId: "12345",
      appHash: "cfgHashcfgHashcfgHashcfgHashcfg1",
    });
    expect(creds).toEqual({
      apiId: 12345,
      apiHash: "cfgHashcfgHashcfgHashcfgHashcfg1",
    });
  });

  it("accepts a numeric configured appId and trims the hash", () => {
    const creds = resolveTelegramAppCredentials(makeRuntime(), {
      appId: 67890,
      appHash: "  spacedHashspacedHashspacedHas  ",
    });
    expect(creds).toEqual({
      apiId: 67890,
      apiHash: "spacedHashspacedHashspacedHas",
    });
  });

  it("falls through to TELEGRAM_APP_ID / TELEGRAM_APP_HASH settings when no config", () => {
    const creds = resolveTelegramAppCredentials(
      makeRuntime({
        TELEGRAM_APP_ID: "555",
        TELEGRAM_APP_HASH: "envHashenvHashenvHashenvHashenv1",
      }),
      {},
    );
    expect(creds).toEqual({
      apiId: 555,
      apiHash: "envHashenvHashenvHashenvHashenv1",
    });
  });

  it("uses user-owned provisioning when neither config nor settings resolve", () => {
    expect(resolveTelegramAppCredentials(makeRuntime(), {})).toBeNull();
  });

  it("ignores a config with a blank appHash and uses the next tier", () => {
    const creds = resolveTelegramAppCredentials(
      makeRuntime({
        TELEGRAM_APP_ID: "777",
        TELEGRAM_APP_HASH: "envHashenvHashenvHashenvHashenv2",
      }),
      { appId: "12345", appHash: "   " },
    );
    expect(creds).toEqual({
      apiId: 777,
      apiHash: "envHashenvHashenvHashenvHashenv2",
    });
  });

  it("ignores a non-numeric TELEGRAM_APP_ID and uses user-owned provisioning", () => {
    const creds = resolveTelegramAppCredentials(
      makeRuntime({
        TELEGRAM_APP_ID: "not-a-number",
        TELEGRAM_APP_HASH: "envHashenvHashenvHashenvHashenv3",
      }),
      {},
    );
    expect(creds).toBeNull();
  });

  it("ignores a non-numeric configured appId and falls through to settings", () => {
    const creds = resolveTelegramAppCredentials(
      makeRuntime({
        TELEGRAM_APP_ID: "888",
        TELEGRAM_APP_HASH: "envHashenvHashenvHashenvHashenv5",
      }),
      { appId: "abc", appHash: "cfgHashcfgHashcfgHashcfgHashcfg3" },
    );
    expect(creds).toEqual({
      apiId: 888,
      apiHash: "envHashenvHashenvHashenvHashenv5",
    });
  });

  it("ignores non-positive and fractional configured appIds and uses user-owned provisioning", () => {
    for (const appId of ["-1", 0, 12.5]) {
      const creds = resolveTelegramAppCredentials(makeRuntime(), {
        appId,
        appHash: "cfgHashcfgHashcfgHashcfgHashcfg4",
      });
      expect(creds).toBeNull();
    }
  });

  it("prefers configured creds over deployment settings when both are present", () => {
    const creds = resolveTelegramAppCredentials(
      makeRuntime({
        TELEGRAM_APP_ID: "999",
        TELEGRAM_APP_HASH: "envHashenvHashenvHashenvHashenv4",
      }),
      { appId: "12345", appHash: "cfgHashcfgHashcfgHashcfgHashcfg2" },
    );
    expect(creds).toEqual({
      apiId: 12345,
      apiHash: "cfgHashcfgHashcfgHashcfgHashcfg2",
    });
  });
});

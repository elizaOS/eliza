/**
 * Deterministic contract for scoped owner-contact send-source resolution
 * (live incident: key "discord-nubs-test" used verbatim as a send source →
 * "Send handler not found" on every escalation).
 */

import { describe, expect, it } from "vitest";
import { resolveScopedSendSource } from "./owner-contacts.ts";

describe("resolveScopedSendSource", () => {
  const handlers = new Set([
    "discord",
    "telegram",
    "client_chat",
    "telegram-account",
  ]);
  const has = (source: string) => handlers.has(source);

  it("resolves the live-incident scoped key to its connector", () => {
    expect(resolveScopedSendSource("discord-nubs-test", has)).toBe("discord");
  });

  it("a full key that IS a handler wins over its prefix", () => {
    expect(resolveScopedSendSource("telegram-account", has)).toBe(
      "telegram-account",
    );
  });

  it("prefers the longest registered prefix at '-' boundaries", () => {
    expect(resolveScopedSendSource("telegram-account-backup", has)).toBe(
      "telegram-account",
    );
  });

  it("an unscoped registered source passes through", () => {
    expect(resolveScopedSendSource("discord", has)).toBe("discord");
  });

  it("no registered handler at any boundary returns the full key for honest reporting", () => {
    expect(resolveScopedSendSource("matrix-nubs", has)).toBe("matrix-nubs");
    expect(resolveScopedSendSource("", has)).toBe("");
  });
});

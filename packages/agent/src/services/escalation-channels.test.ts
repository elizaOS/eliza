/**
 * Unit-tests resolveDeliverableChannels: explicit operator channel order wins
 * untouched; an unconfigured order extends the client_chat default with
 * owner-reachable channels from routing hints (most recent owner response
 * first) and owner-contact entries. Pure function, no runtime.
 */
import { describe, expect, test } from "vitest";
import type { OwnerContactRoutingHint } from "../config/owner-contacts.ts";
import { resolveDeliverableChannels } from "./escalation.ts";

const hint = (lastResponseAt: string | null): OwnerContactRoutingHint =>
  ({
    source: "x",
    entityId: null,
    channelId: null,
    roomId: null,
    lastResponseAt,
    lastResponseChannel: null,
    resolvedFrom: "recency",
  }) as unknown as OwnerContactRoutingHint;

describe("resolveDeliverableChannels", () => {
  test("explicit operator order wins untouched", () => {
    const channels = resolveDeliverableChannels(
      { channels: ["telegram"] },
      { discord: {} },
      { discord: hint("2026-08-16T10:00:00Z") },
    );
    expect(channels).toEqual(["telegram"]);
  });

  test("unconfigured order extends client_chat with hinted channels, most recent first", () => {
    const channels = resolveDeliverableChannels(
      {},
      {},
      {
        telegram: hint("2026-08-01T00:00:00Z"),
        discord: hint("2026-08-16T10:00:00Z"),
      },
    );
    expect(channels[0]).toBe("client_chat");
    expect(channels.slice(1)).toEqual(["discord", "telegram"]);
  });

  test("owner-contact channels append after hinted ones without duplicates", () => {
    const channels = resolveDeliverableChannels(
      {},
      { discord: {}, imessage: {} },
      { discord: hint("2026-08-16T10:00:00Z") },
    );
    expect(channels).toEqual(["client_chat", "discord", "imessage"]);
  });

  test("no hints and no contacts keeps the bare default", () => {
    expect(resolveDeliverableChannels({}, {}, {})).toEqual(["client_chat"]);
  });
});

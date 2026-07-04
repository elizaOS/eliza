/**
 * Hardening tests for `NostrService` configuration and edge cases (e.g. missing
 * keys raising `NostrConfigurationError`), against a mocked runtime — no relays,
 * runs offline.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { NostrService } from "../service.js";
import { NostrConfigurationError } from "../types.js";

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { settings: {} },
    emitEvent: vi.fn(),
    getSetting: vi.fn(() => null),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function service(overrides: Record<string, unknown> = {}): NostrService {
  const instance = Object.create(NostrService.prototype) as NostrService;
  Object.assign(instance, {
    runtime: runtime(),
    accountServices: new Map(),
    connected: true,
    seenEventIds: new Set(),
    settings: {
      accountId: "default",
      privateKey: "1".repeat(64),
      publicKey: "2".repeat(64),
      relays: ["wss://relay.example"],
      dmPolicy: "open",
      allowFrom: [],
      enabled: true,
    },
    privateKey: new Uint8Array(32).fill(1),
    pool: {
      publish: vi.fn(async () => undefined),
      querySync: vi.fn(async () => []),
    },
    ...overrides,
  });
  return instance;
}

describe("NostrService hardening", () => {
  it.each([
    "https://relay.example",
    "javascript:alert(1)",
    "wss://user:pass@relay.example",
    "not a url",
  ])("rejects unsafe relay URL %s", (relay) => {
    const instance = service({
      settings: {
        accountId: "default",
        privateKey: "1".repeat(64),
        publicKey: "2".repeat(64),
        relays: [relay],
        dmPolicy: "open",
        allowFrom: [],
        enabled: true,
      },
    });

    expect(() =>
      (instance as unknown as { validateSettings: () => void }).validateSettings()
    ).toThrow(NostrConfigurationError);
  });

  it.each([
    null,
    {},
    { id: "evt", pubkey: "p", tags: [], content: "x" },
    { id: "evt", pubkey: "p", tags: "not-tags", content: "x", created_at: 1 },
  ])("ignores malformed incoming event payload %#", async (event) => {
    const instance = service();
    const emitEvent = vi.fn();
    Object.assign(instance, { runtime: { ...runtime(), emitEvent } });

    await (instance as unknown as { handleEvent: (event: unknown) => Promise<void> }).handleEvent(
      event
    );

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("rejects empty DM text before encrypting or publishing", async () => {
    const publish = vi.fn(async () => undefined);
    const instance = service({ pool: { publish, querySync: vi.fn() } });

    await expect(instance.sendDm({ toPubkey: "a".repeat(64), text: "   " })).resolves.toEqual({
      success: false,
      error: "DM content cannot be empty",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("filters hostile note tags before publishing", async () => {
    const publish = vi.fn(async () => undefined);
    const instance = service({ pool: { publish, querySync: vi.fn() } });

    await expect(
      instance.publishNote("hello", [
        ["p", "a".repeat(64), 42 as never],
        [null as never],
        "bad" as never,
      ])
    ).resolves.toMatchObject({
      success: true,
      relays: ["wss://relay.example"],
    });

    const publishedEvent = publish.mock.calls[0]?.[1] as {
      tags?: unknown;
    };
    expect(publishedEvent.tags).toEqual([["p", "a".repeat(64)]]);
  });

  it("maps malformed event timestamps and tags to safe memory metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000);
    const rt = runtime();
    const instance = service();
    const memory = (
      instance as unknown as {
        nostrEventToPostMemory: (
          runtime: IAgentRuntime,
          event: unknown
        ) => {
          createdAt: number;
          metadata: { nostr: { tags: unknown } };
        };
      }
    ).nostrEventToPostMemory(rt, {
      id: "evt-1",
      pubkey: "a".repeat(64),
      kind: 1,
      content: "note",
      created_at: Number.NaN,
      tags: [["t", "ok", 1], [null], "bad"],
      sig: "sig",
    });

    expect(memory.createdAt).toBe(1_800_000);
    expect(memory.metadata.nostr.tags).toEqual([["t", "ok"]]);
    vi.useRealTimers();
  });
});

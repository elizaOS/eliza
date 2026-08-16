/** Exercises the real Durable Object delivery ledger's fenced multipart transitions. */

import { describe, expect, mock, test } from "bun:test";
import { parseTelegramBotId } from "@elizaos/cloud-services-common/telegram-account";
import { sha256Hex } from "@/lib/oidc/crypto";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  PersonalTelegramDelivery,
  personalTelegramDeliveryObjectName,
} from "./personal-telegram-delivery";

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));
const deliveryModule = import("./personal-telegram-delivery");

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    if (!Array.isArray(key)) return this.values.delete(key);
    let deleted = 0;
    for (const item of key) if (this.values.delete(item)) deleted += 1;
    return deleted;
  }
  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.values as Map<string, T>);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }
}

function durableState(storage = new MemoryStorage()): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";

function operation(
  messageId: string,
  value: string,
  input: Record<string, unknown> = {},
): Request {
  const path = "/v1/delivery";
  return new Request(`https://personal-telegram-delivery${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId, operation: value, ...input }),
  });
}
async function json(
  response: Promise<Response>,
): Promise<Record<string, unknown>> {
  return (await response).json() as Promise<Record<string, unknown>>;
}

describe("PersonalTelegramDelivery", () => {
  test("persists multipart cursor and receipts across object eviction", async () => {
    const { PersonalTelegramDelivery } = await deliveryModule;
    const storage = new MemoryStorage();
    const first = new PersonalTelegramDelivery(
      durableState(storage),
      {} as never,
    );
    expect(
      await json(
        first.fetch(
          operation("123", "claim_processing", {
            ownerToken: ownerA,
            leaseMs: 30_000,
          }),
        ),
      ),
    ).toEqual({ claimed: true });
    await first.fetch(
      operation("123", "prepare_plan", {
        ownerToken: ownerA,
        contentDigest: "a".repeat(64),
        totalChunks: 2,
      }),
    );
    await first.fetch(
      operation("123", "claim_chunk", { ownerToken: ownerA, chunkIndex: 0 }),
    );
    await first.fetch(
      operation("123", "record_accepted", {
        ownerToken: ownerA,
        chunkIndex: 0,
        providerMessageId: "42",
      }),
    );
    const afterEviction = new PersonalTelegramDelivery(
      durableState(storage),
      {} as never,
    );
    expect(
      await json(afterEviction.fetch(operation("123", "read"))),
    ).toMatchObject({
      progress: {
        state: "pending",
        nextChunkIndex: 1,
        providerMessageIds: ["42"],
      },
    });
  });

  test("stale owners cannot renew, release, or mutate a successor claim", async () => {
    const { PersonalTelegramDelivery } = await deliveryModule;
    const storage = new MemoryStorage();
    const object = new PersonalTelegramDelivery(
      durableState(storage),
      {} as never,
    );
    await object.fetch(
      operation("456", "claim_processing", {
        ownerToken: ownerA,
        leaseMs: 30_000,
      }),
    );
    storage.values.delete("processing:456");
    await object.fetch(
      operation("456", "claim_processing", {
        ownerToken: ownerB,
        leaseMs: 30_000,
      }),
    );
    expect(
      await json(
        object.fetch(
          operation("456", "renew_processing", {
            ownerToken: ownerA,
            leaseMs: 30_000,
          }),
        ),
      ),
    ).toEqual({ renewed: false });
    await object.fetch(
      operation("456", "release_processing", { ownerToken: ownerA }),
    );
    expect(
      await json(
        object.fetch(
          operation("456", "renew_processing", {
            ownerToken: ownerB,
            leaseMs: 30_000,
          }),
        ),
      ),
    ).toEqual({ renewed: true });
    expect(
      (
        await object.fetch(
          operation("456", "prepare_plan", {
            ownerToken: ownerA,
            contentDigest: "b".repeat(64),
            totalChunks: 1,
          }),
        )
      ).status,
    ).toBe(409);
  });

  test("explicit rejection reopens the active chunk while unknown acceptance remains tombstoned", async () => {
    const { PersonalTelegramDelivery } = await deliveryModule;
    const object = new PersonalTelegramDelivery(durableState(), {} as never);
    await object.fetch(
      operation("789", "claim_processing", {
        ownerToken: ownerA,
        leaseMs: 30_000,
      }),
    );
    await object.fetch(
      operation("789", "prepare_plan", {
        ownerToken: ownerA,
        contentDigest: "c".repeat(64),
        totalChunks: 1,
      }),
    );
    await object.fetch(
      operation("789", "claim_chunk", { ownerToken: ownerA, chunkIndex: 0 }),
    );
    expect(await json(object.fetch(operation("789", "read")))).toMatchObject({
      progress: { state: "egress_started", activeChunkIndex: 0 },
    });
    await object.fetch(
      operation("789", "record_explicit_rejection", {
        ownerToken: ownerA,
        chunkIndex: 0,
      }),
    );
    expect(await json(object.fetch(operation("789", "read")))).toMatchObject({
      progress: { state: "pending", nextChunkIndex: 0 },
    });
  });

  test("physically deletes expired keys and schedules the next expiration", async () => {
    const { PersonalTelegramDelivery } = await deliveryModule;
    const storage = new MemoryStorage();
    const object = new PersonalTelegramDelivery(
      durableState(storage),
      {} as never,
    );
    storage.values.set("delivery:old", {
      value: {},
      expiresAt: Date.now() - 1,
    });
    const nextExpiration = Date.now() + 60_000;
    storage.values.set("delivery:live", {
      value: {},
      expiresAt: nextExpiration,
    });
    await object.alarm();
    expect(storage.values.has("delivery:old")).toBe(false);
    expect(storage.alarmAt).toBe(nextExpiration);
  });

  test("keeps one authority across gateway-edge-gateway cutover and token rotation", async () => {
    const oldToken = "123456789:AAAAAAAAAAAAAAAAAAAA";
    const rotatedToken = "123456789:BBBBBBBBBBBBBBBBBBBB";
    const oldFingerprint = await sha256Hex(parseTelegramBotId(oldToken));
    const rotatedFingerprint = await sha256Hex(
      parseTelegramBotId(rotatedToken),
    );
    expect(rotatedFingerprint).toBe(oldFingerprint);

    const scope = {
      project: "eliza-app",
      accountFingerprint: oldFingerprint,
      senderId: "987654321",
    };
    const rotatedScope = { ...scope, accountFingerprint: rotatedFingerprint };
    expect(await personalTelegramDeliveryObjectName(rotatedScope)).toBe(
      await personalTelegramDeliveryObjectName(scope),
    );

    const object = new PersonalTelegramDelivery(
      durableState(),
      {} as AppEnv["Bindings"],
    );
    expect(
      await json(
        object.fetch(
          operation("1001", "claim_processing", {
            ownerToken: ownerA,
            leaseMs: 30_000,
          }),
        ),
      ),
    ).toEqual({ claimed: true });
    await object.fetch(
      operation("1001", "release_processing", { ownerToken: ownerA }),
    );
    expect(
      await json(
        object.fetch(
          operation("1001", "claim_processing", {
            ownerToken: ownerB,
            leaseMs: 30_000,
          }),
        ),
      ),
    ).toEqual({ claimed: true });
    await object.fetch(
      operation("1001", "prepare_plan", {
        ownerToken: ownerB,
        contentDigest: "c".repeat(64),
        totalChunks: 1,
      }),
    );
    expect(
      await json(
        object.fetch(
          operation("1001", "claim_chunk", {
            ownerToken: ownerB,
            chunkIndex: 0,
          }),
        ),
      ),
    ).toMatchObject({ claimed: true });
    await object.fetch(
      operation("1001", "release_processing", { ownerToken: ownerB }),
    );
    expect(
      await json(
        object.fetch(
          operation("1001", "claim_processing", {
            ownerToken: ownerA,
            leaseMs: 30_000,
          }),
        ),
      ),
    ).toEqual({ claimed: true });
    expect(await json(object.fetch(operation("1001", "read")))).toMatchObject({
      progress: { state: "egress_started", activeChunkIndex: 0 },
    });
    expect(
      await json(
        object.fetch(
          operation("1001", "claim_chunk", {
            ownerToken: ownerA,
            chunkIndex: 0,
          }),
        ),
      ),
    ).toMatchObject({ claimed: false });
  });

  test("serializes mixed concurrent claims from cutover authorities", async () => {
    const object = new PersonalTelegramDelivery(
      durableState(),
      {} as AppEnv["Bindings"],
    );
    const owners = Array.from(
      { length: 12 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const claims = await Promise.all(
      owners.map((ownerToken) =>
        json(
          object.fetch(
            operation("2002", "claim_processing", {
              ownerToken,
              leaseMs: 30_000,
            }),
          ),
        ),
      ),
    );
    expect(
      claims.filter(
        (claim) => (claim as { claimed?: boolean }).claimed === true,
      ),
    ).toHaveLength(1);

    const winningOwner = owners[claims.findIndex((claim) => claim.claimed)];
    await object.fetch(
      operation("2002", "prepare_plan", {
        ownerToken: winningOwner,
        contentDigest: "d".repeat(64),
        totalChunks: 1,
      }),
    );
    const egressClaims = await Promise.all(
      Array.from({ length: 12 }, () =>
        json(
          object.fetch(
            operation("2002", "claim_chunk", {
              ownerToken: winningOwner,
              chunkIndex: 0,
            }),
          ),
        ),
      ),
    );
    expect(
      egressClaims.filter(
        (claim) => (claim as { claimed?: boolean }).claimed === true,
      ),
    ).toHaveLength(1);
  });
});

/** Exercises durable Telegram delivery claims, eviction survival, and validation. */

import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  PERSONAL_TELEGRAM_DELIVERY_PATH,
  PersonalTelegramDelivery,
} from "./personal-telegram-delivery";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(
    key: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, structuredClone(entryValue));
    }
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const item of key) {
        if (this.values.delete(item)) deleted += 1;
      }
      return deleted;
    }
    return this.values.delete(key);
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

function operation(
  messageId: string,
  value: string,
  input: Record<string, unknown> = {},
): Request {
  return new Request(
    `https://personal-telegram-delivery${PERSONAL_TELEGRAM_DELIVERY_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, operation: value, ...input }),
    },
  );
}

async function json(response: Promise<Response>): Promise<unknown> {
  return (await response).json();
}

describe("PersonalTelegramDelivery", () => {
  test("persists an uncertain chunk across object eviction", async () => {
    const storage = new MemoryStorage();
    const first = new PersonalTelegramDelivery(
      durableState(storage),
      {} as AppEnv["Bindings"],
    );
    const chunkDigest = "a".repeat(64);
    expect(
      await json(
        first.fetch(
          operation("123", "prepare_plan", {
            chunkDigests: [chunkDigest],
          }),
        ),
      ),
    ).toEqual({ plan: "prepared" });
    expect(
      await json(
        first.fetch(
          operation("123", "claim_chunk", {
            chunkIndex: 0,
            chunkDigest,
          }),
        ),
      ),
    ).toEqual({ claimed: true });

    const afterEviction = new PersonalTelegramDelivery(
      durableState(storage),
      {} as AppEnv["Bindings"],
    );
    expect(
      await json(
        afterEviction.fetch(
          operation("123", "read_chunk", {
            chunkIndex: 0,
            chunkDigest,
          }),
        ),
      ),
    ).toEqual({ state: "uncertain" });
    expect(
      await json(
        afterEviction.fetch(
          operation("123", "claim_chunk", {
            chunkIndex: 0,
            chunkDigest,
          }),
        ),
      ),
    ).toEqual({ claimed: false });
  });

  test("serializes processing claims and permits explicit pre-egress release", async () => {
    const object = new PersonalTelegramDelivery(
      durableState(),
      {} as AppEnv["Bindings"],
    );
    expect(
      await json(object.fetch(operation("456", "claim_processing"))),
    ).toEqual({ claimed: true });
    expect(
      await json(object.fetch(operation("456", "claim_processing"))),
    ).toEqual({ claimed: false });
    expect(
      await json(object.fetch(operation("456", "release_processing"))),
    ).toEqual({ released: true });
    expect(
      await json(object.fetch(operation("456", "claim_processing"))),
    ).toEqual({ claimed: true });
  });

  test("marks delivery complete and rejects malformed message identifiers", async () => {
    const object = new PersonalTelegramDelivery(
      durableState(),
      {} as AppEnv["Bindings"],
    );
    expect(
      await json(object.fetch(operation("789", "mark_delivered"))),
    ).toEqual({ state: "delivered" });
    expect(await json(object.fetch(operation("789", "read")))).toEqual({
      state: "delivered",
    });
    expect((await object.fetch(operation("../secret", "read"))).status).toBe(
      400,
    );
  });

  test("persists provider receipts for reminder idempotency keys", async () => {
    const object = new PersonalTelegramDelivery(
      durableState(),
      {} as AppEnv["Bindings"],
    );
    const messageId = "reminder-1:2026-08-20T19:30:00.000Z";
    const chunkDigest = "b".repeat(64);
    await object.fetch(
      operation(messageId, "prepare_plan", { chunkDigests: [chunkDigest] }),
    );
    await object.fetch(
      operation(messageId, "claim_chunk", { chunkIndex: 0, chunkDigest }),
    );
    const marked = await object.fetch(
      operation(messageId, "mark_chunk_delivered", {
        chunkIndex: 0,
        chunkDigest,
        providerMessageId: "9004",
      }),
    );

    expect(marked.status).toBe(200);
    expect(
      await json(object.fetch(operation(messageId, "read_receipt"))),
    ).toMatchObject({ providerMessageIds: ["9004"] });
    expect(
      (await json(object.fetch(operation(messageId, "read_receipt")))) as {
        acceptedAt: string;
      },
    ).toEqual(
      expect.objectContaining({
        acceptedAt: expect.stringMatching(/^2026-|^2027-/),
      }),
    );
  });

  test("never downgrades a delivered turn during legacy reconciliation", async () => {
    const object = new PersonalTelegramDelivery(
      durableState(),
      {} as AppEnv["Bindings"],
    );
    expect(
      await json(object.fetch(operation("790", "mark_delivered"))),
    ).toEqual({ state: "delivered" });
    expect(
      await json(object.fetch(operation("790", "mark_uncertain"))),
    ).toEqual({ state: "delivered" });
    expect(await json(object.fetch(operation("790", "read")))).toEqual({
      state: "delivered",
    });
  });

  test("physically deletes expired keys and schedules the next live expiration", async () => {
    const storage = new MemoryStorage();
    const object = new PersonalTelegramDelivery(
      durableState(storage),
      {} as AppEnv["Bindings"],
    );
    storage.values.set("delivery:old", {
      value: "delivered",
      expiresAt: Date.now() - 1,
    });
    const nextExpiration = Date.now() + 60_000;
    storage.values.set("delivery:live", {
      value: "delivered",
      expiresAt: nextExpiration,
    });

    await object.alarm();

    expect(storage.values.has("delivery:old")).toBe(false);
    expect(storage.values.has("delivery:live")).toBe(true);
    expect(storage.alarmAt).toBe(nextExpiration);
  });
});

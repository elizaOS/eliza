/**
 * Deterministic coverage for privacy-preserving device-local passkey hints.
 * Web Crypto is real; only browser storage is an in-memory test boundary.
 */

import { describe, expect, it } from "vitest";
import {
  hasPasskeyDeviceHint,
  normalizePasskeyHintEmail,
  PASSKEY_DEVICE_HINT_STORAGE_KEY,
  type PasskeyDeviceHintEnvironment,
  rememberPasskeyDeviceHint,
} from "./passkey-device-hints";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createEnvironment(storage = new MemoryStorage()): {
  environment: PasskeyDeviceHintEnvironment;
  storage: MemoryStorage;
} {
  return {
    environment: { storage, crypto: globalThis.crypto },
    storage,
  };
}

describe("passkey device hints", () => {
  it("normalizes whitespace, case, and compatible Unicode forms", () => {
    expect(normalizePasskeyHintEmail("  PERSON@EXAMPLE.COM  ")).toBe(
      "person@example.com",
    );
    expect(normalizePasskeyHintEmail("ｐｅｒｓｏｎ@example.com")).toBe(
      "person@example.com",
    );
  });

  it("matches normalized emails without storing plaintext or a stable digest", async () => {
    const first = createEnvironment();
    const second = createEnvironment();

    await expect(
      rememberPasskeyDeviceHint(" Person@Example.com ", first.environment),
    ).resolves.toBe(true);
    await expect(
      hasPasskeyDeviceHint("person@example.com", first.environment),
    ).resolves.toBe(true);

    const firstRaw = first.storage.getItem(PASSKEY_DEVICE_HINT_STORAGE_KEY);
    expect(firstRaw).not.toBeNull();
    expect(firstRaw?.toLowerCase()).not.toContain("person");
    expect(firstRaw?.toLowerCase()).not.toContain("example.com");

    await rememberPasskeyDeviceHint("person@example.com", second.environment);
    expect(second.storage.getItem(PASSKEY_DEVICE_HINT_STORAGE_KEY)).not.toBe(
      firstRaw,
    );
  });

  it("keeps only the sixteen most recently marked emails", async () => {
    const { environment, storage } = createEnvironment();
    for (let index = 0; index < 20; index += 1) {
      await rememberPasskeyDeviceHint(
        `person-${index}@example.com`,
        environment,
      );
    }

    const raw = storage.getItem(PASSKEY_DEVICE_HINT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}").hints).toHaveLength(16);
    await expect(
      hasPasskeyDeviceHint("person-0@example.com", environment),
    ).resolves.toBe(false);
    await expect(
      hasPasskeyDeviceHint("person-19@example.com", environment),
    ).resolves.toBe(true);
  });

  it("treats corrupted storage as unhinted and replaces it on a later success", async () => {
    const { environment, storage } = createEnvironment();
    storage.setItem(PASSKEY_DEVICE_HINT_STORAGE_KEY, "not-json");

    await expect(
      hasPasskeyDeviceHint("person@example.com", environment),
    ).resolves.toBe(false);
    await expect(
      rememberPasskeyDeviceHint("person@example.com", environment),
    ).resolves.toBe(true);
    await expect(
      hasPasskeyDeviceHint("person@example.com", environment),
    ).resolves.toBe(true);
  });

  it("fails closed when storage is unavailable", async () => {
    await expect(
      hasPasskeyDeviceHint("person@example.com", null),
    ).resolves.toBe(false);
    await expect(
      rememberPasskeyDeviceHint("person@example.com", null),
    ).resolves.toBe(false);
  });
});

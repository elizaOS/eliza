import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../utils/logger";
import { cache } from "./client";
import { DistributedLockService, distributedLocks } from "./distributed-locks";

const service = DistributedLockService.getInstance();

describe("DistributedLockService", () => {
  beforeEach(() => {
    vi.spyOn(cache, "isAvailable").mockReturnValue(true);
    vi.spyOn(cache, "setIfNotExists").mockResolvedValue(true);
    vi.spyOn(cache, "get").mockResolvedValue(null);
    vi.spyOn(cache, "del").mockResolvedValue(true);
    vi.spyOn(cache, "pttl").mockResolvedValue(90000);
    vi.spyOn(cache, "pexpire").mockResolvedValue(true);
    vi.spyOn(logger, "info").mockReset();
    vi.spyOn(logger, "warn").mockReset();
    vi.spyOn(logger, "debug").mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("acquireRoomLock", () => {
    it("acquires a lock via SET NX with a TTL and exposes release/extend", async () => {
      vi.mocked(cache.setIfNotExists).mockResolvedValue(true);
      const lock = await service.acquireRoomLock("room-a", 5000);

      expect(lock).not.toBeNull();
      expect(cache.setIfNotExists).toHaveBeenCalledWith(
        "agent:room:room-a:lock",
        expect.any(String),
        5000,
      );
      expect(lock!.lockId).toBeTypeOf("string");
      expect(lock!.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // release() delegates to the ownership-checked release path
      vi.mocked(cache.get).mockResolvedValue(lock!.lockId);
      await expect(lock!.release()).resolves.toBeUndefined();
      expect(cache.del).toHaveBeenCalledWith("agent:room:room-a:lock");
    });

    it("returns null when the lock is already held", async () => {
      vi.mocked(cache.setIfNotExists).mockResolvedValue(false);
      const lock = await service.acquireRoomLock("room-a");
      expect(lock).toBeNull();
    });

    it("returns a dummy lock when the cache is unavailable", async () => {
      vi.mocked(cache.isAvailable).mockReturnValue(false);
      const lock = await service.acquireRoomLock("room-a", 5000);
      expect(lock).not.toBeNull();
      expect(cache.setIfNotExists).not.toHaveBeenCalled();
      await expect(lock!.release()).resolves.toBeUndefined();
      await expect(lock!.extend(1000)).resolves.toBeUndefined();
    });
  });

  describe("releaseRoomLock ownership guard", () => {
    it("releases only when the caller still owns the lock", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      const released = await service.releaseRoomLock("room-a", "my-lock-id");
      expect(released).toBe(true);
      expect(cache.del).toHaveBeenCalledWith("agent:room:room-a:lock");
    });

    it("refuses to release a lock held by another owner", async () => {
      // A stale holder (e.g. after its TTL expired and someone else took the
      // lock) must NOT be able to delete the current owner's lock.
      vi.mocked(cache.get).mockResolvedValue("other-lock-id");
      const released = await service.releaseRoomLock("room-a", "stale-lock-id");
      expect(released).toBe(false);
      expect(cache.del).not.toHaveBeenCalled();
    });

    it("refuses to release a lock that no longer exists (expired)", async () => {
      vi.mocked(cache.get).mockResolvedValue(null);
      const released = await service.releaseRoomLock("room-a", "my-lock-id");
      expect(released).toBe(false);
      expect(cache.del).not.toHaveBeenCalled();
    });

    it("treats a missing cache as released (no-op)", async () => {
      vi.mocked(cache.isAvailable).mockReturnValue(false);
      expect(await service.releaseRoomLock("room-a", "anything")).toBe(true);
      expect(cache.del).not.toHaveBeenCalled();
    });
  });

  describe("extendLock", () => {
    it("extends the TTL by the requested amount when owned", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      vi.mocked(cache.pttl).mockResolvedValue(30000);
      const extended = await service.extendLock("room-a", "my-lock-id", 5000);
      expect(extended).toBe(true);
      expect(cache.pexpire).toHaveBeenCalledWith("agent:room:room-a:lock", 35000);
    });

    it("refuses to extend a lock owned by someone else", async () => {
      vi.mocked(cache.get).mockResolvedValue("other-lock-id");
      const extended = await service.extendLock("room-a", "my-lock-id", 5000);
      expect(extended).toBe(false);
      expect(cache.pexpire).not.toHaveBeenCalled();
    });

    it("refuses to extend an already-expired lock", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      vi.mocked(cache.pttl).mockResolvedValue(0);
      expect(await service.extendLock("room-a", "my-lock-id", 5000)).toBe(false);
      expect(cache.pexpire).not.toHaveBeenCalled();
    });

    it("refuses to extend when the TTL lookup reports no expiry", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      vi.mocked(cache.pttl).mockResolvedValue(null);
      expect(await service.extendLock("room-a", "my-lock-id", 5000)).toBe(false);
      expect(cache.pexpire).not.toHaveBeenCalled();
    });
  });

  describe("isLocked", () => {
    it("reports locked when a lock id is present", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      expect(await service.isLocked("room-a")).toBe(true);
    });

    it("reports unlocked when the key is absent (null miss)", async () => {
      vi.mocked(cache.get).mockResolvedValue(null);
      expect(await service.isLocked("room-a")).toBe(false);
    });

    it("treats an undefined cache miss as unlocked, not locked", async () => {
      // Some cache drivers surface a miss as `undefined` rather than `null`.
      // A miss must never read as "locked" — that would deadlock the room.
      vi.mocked(cache.get).mockResolvedValue(undefined);
      expect(await service.isLocked("room-a")).toBe(false);
    });

    it("returns false when the cache is unavailable", async () => {
      vi.mocked(cache.isAvailable).mockReturnValue(false);
      expect(await service.isLocked("room-a")).toBe(false);
    });
  });

  describe("getLockInfo", () => {
    it("returns lockId and remaining TTL when locked", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      vi.mocked(cache.pttl).mockResolvedValue(42000);
      expect(await service.getLockInfo("room-a")).toEqual({
        lockId: "my-lock-id",
        ttl: 42000,
      });
    });

    it("returns null when not locked", async () => {
      vi.mocked(cache.get).mockResolvedValue(null);
      expect(await service.getLockInfo("room-a")).toBeNull();
    });

    it("returns null when the TTL lookup fails", async () => {
      vi.mocked(cache.get).mockResolvedValue("my-lock-id");
      vi.mocked(cache.pttl).mockResolvedValue(null);
      expect(await service.getLockInfo("room-a")).toBeNull();
    });
  });

  describe("forceRelease", () => {
    it("deletes the lock key unconditionally", async () => {
      expect(await service.forceRelease("room-a")).toBe(true);
      expect(cache.del).toHaveBeenCalledWith("agent:room:room-a:lock");
    });
  });

  describe("acquireRoomLockWithRetry", () => {
    it("succeeds immediately on the first attempt", async () => {
      vi.mocked(cache.setIfNotExists).mockResolvedValue(true);
      const lock = await service.acquireRoomLockWithRetry("room-a", 1000, {
        maxRetries: 3,
        initialDelayMs: 5,
        maxDelayMs: 10,
      });
      expect(lock).not.toBeNull();
      expect(cache.setIfNotExists).toHaveBeenCalledTimes(1);
    });

    it("retries with backoff until success and reports the retry count", async () => {
      vi.useFakeTimers();
      vi.mocked(cache.setIfNotExists)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const pending = service.acquireRoomLockWithRetry("room-a", 1000, {
        maxRetries: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const lock = await pending;

      expect(lock).not.toBeNull();
      expect(cache.setIfNotExists).toHaveBeenCalledTimes(3);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("after 2 retries"));
    });

    it("gives up after maxRetries + 1 attempts and returns null", async () => {
      vi.useFakeTimers();
      vi.mocked(cache.setIfNotExists).mockResolvedValue(false);
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const pending = service.acquireRoomLockWithRetry("room-a", 1000, {
        maxRetries: 2,
        initialDelayMs: 10,
        maxDelayMs: 100,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const lock = await pending;

      expect(lock).toBeNull();
      expect(cache.setIfNotExists).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("after 3 attempts"));
    });

    it("never retries when maxRetries is 0", async () => {
      vi.mocked(cache.setIfNotExists).mockResolvedValue(false);
      const lock = await service.acquireRoomLockWithRetry("room-a", 1000, {
        maxRetries: 0,
      });
      expect(lock).toBeNull();
      expect(cache.setIfNotExists).toHaveBeenCalledTimes(1);
    });
  });

  describe("singleton", () => {
    it("is exposed as a singleton instance", () => {
      expect(distributedLocks).toBeInstanceOf(DistributedLockService);
      expect(distributedLocks).toBe(service);
    });
  });
});

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage-memory";

interface Item {
  id: string;
  roomId: string;
  value: number;
}

describe("MemoryStorage", () => {
  it("requires initialization before operations and clears readiness on close", async () => {
    const storage = new MemoryStorage();

    await expect(storage.isReady()).resolves.toBe(false);
    await expect(storage.get("items", "one")).rejects.toThrow(
      "MemoryStorage is not initialized",
    );

    await storage.init();
    await expect(storage.isReady()).resolves.toBe(true);
    await storage.set("items", "one", { ok: true });

    await storage.close();

    await expect(storage.isReady()).resolves.toBe(false);
    await expect(storage.get("items", "one")).rejects.toThrow(
      "MemoryStorage is not initialized",
    );
  });

  it("isolates collections and returns null for missing ids", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("rooms", "same-id", { collection: "rooms" });
    await storage.set("memories", "same-id", { collection: "memories" });

    await expect(storage.get("rooms", "same-id")).resolves.toEqual({
      collection: "rooms",
    });
    await expect(storage.get("memories", "same-id")).resolves.toEqual({
      collection: "memories",
    });
    await expect(storage.get("memories", "missing")).resolves.toBeNull();
  });

  it("filters, counts, and deletes by predicate", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set<Item>("items", "a", { id: "a", roomId: "r1", value: 1 });
    await storage.set<Item>("items", "b", { id: "b", roomId: "r1", value: 2 });
    await storage.set<Item>("items", "c", { id: "c", roomId: "r2", value: 3 });

    await expect(storage.getWhere<Item>("items", (item) => item.roomId === "r1")).resolves.toEqual([
      { id: "a", roomId: "r1", value: 1 },
      { id: "b", roomId: "r1", value: 2 },
    ]);
    await expect(storage.count<Item>("items", (item) => item.value >= 2)).resolves.toBe(2);

    await storage.deleteWhere<Item>("items", (item) => item.roomId === "r1");

    await expect(storage.getAll<Item>("items")).resolves.toEqual([
      { id: "c", roomId: "r2", value: 3 },
    ]);
  });

  it("deletes individual and multiple ids and reports whether a single delete matched", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("items", "a", { id: "a" });
    await storage.set("items", "b", { id: "b" });
    await storage.set("items", "c", { id: "c" });

    await expect(storage.delete("items", "missing")).resolves.toBe(false);
    await expect(storage.delete("items", "a")).resolves.toBe(true);
    await storage.deleteMany("items", ["b", "missing"]);

    await expect(storage.getAll("items")).resolves.toEqual([{ id: "c" }]);
    await expect(storage.count("items")).resolves.toBe(1);
  });

  it("clear removes all collections while preserving readiness", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("a", "1", { id: 1 });
    await storage.set("b", "2", { id: 2 });
    await storage.clear();

    await expect(storage.isReady()).resolves.toBe(true);
    await expect(storage.getAll("a")).resolves.toEqual([]);
    await expect(storage.getAll("b")).resolves.toEqual([]);
  });
});

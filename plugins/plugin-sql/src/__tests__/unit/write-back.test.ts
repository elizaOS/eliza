import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteBackService } from "../../write-back";

/**
 * Unit tests for WriteBackService.
 *
 * These tests validate the queue, debounce, retry, and flush logic
 * without requiring PGlite WASM or Docker containers.
 */

describe("WriteBackService", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("is disabled when no options are provided", () => {
    const wb = new WriteBackService();
    expect(wb.enabled).toBe(false);
  });

  it("is disabled when only url is provided but no key", () => {
    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
    });
    expect(wb.enabled).toBe(false);
  });

  it("is enabled when url, agentId, and key are provided", () => {
    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });
    expect(wb.enabled).toBe(true);
  });

  it("builds the correct write URL", () => {
    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com/",
      agentId: "test-agent-id",
      serviceKey: "key-1",
    });
    // The URL is private, but we can verify via fetch spy.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    wb.enqueue("memories", "insert", { id: "m-1", content: "hello" });
    // Flush synchronously
    return wb.flush().then(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain("/api/v1/eliza/agents/test-agent-id/write");
    });
  });

  it("enqueue is a no-op when disabled", () => {
    const wb = new WriteBackService();
    // Should not throw.
    expect(() => wb.enqueue("memories", "insert", { id: "1" })).not.toThrow();
  });

  it("flush resolves immediately when queue is empty", async () => {
    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });
    await expect(wb.flush()).resolves.toBeUndefined();
  });

  it("sends batched writes to the cloud API", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("memories", "insert", { id: "m-1", content: "hello" });
    wb.enqueue("rooms", "insert", { id: "r-1", name: "test-room" });

    await wb.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.writes).toHaveLength(2);
    expect(body.writes[0].table).toBe("memories");
    expect(body.writes[0].operation).toBe("insert");
    expect(body.writes[0].row.id).toBe("m-1");
    expect(body.writes[1].table).toBe("rooms");
    expect(body.writes[1].row.name).toBe("test-room");

    // Verify auth header.
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Service-Key"]).toBe("key-1");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("retries failed writes up to MAX_RETRIES", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("memories", "insert", { id: "m-1" });

    // First flush: fails, re-queues. We flush again.
    await wb.flush(); // fails, re-queues
    await wb.flush(); // fails again
    await wb.flush(); // succeeds

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("drops writes after exceeding MAX_RETRIES", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Persistent error"));

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("memories", "insert", { id: "m-1" });

    // 6 flushes = 1 initial + 5 retries = 6 total calls, after which it drops.
    for (let i = 0; i < 6; i++) {
      await wb.flush();
    }
    // 7th flush should have nothing to send (write was dropped).
    await wb.flush();

    // 6 calls for the first write (initial + 5 retries).
    // But since scheduleFlush after the 6th retry (retries=6 > MAX_RETRIES=5)
    // re-queues nothing, we should see exactly 6 calls.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("handles HTTP error responses by retrying", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Server error", { status: 500 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("memories", "insert", { id: "m-1" });

    await wb.flush(); // HTTP 500, re-queues
    await wb.flush(); // succeeds

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends delete operations", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("memories", "delete", { id: "m-1" });

    await wb.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.writes[0].operation).toBe("delete");
  });

  it("sends upsert operations", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("agents", "upsert", {
      id: "a-1",
      name: "test",
      created_at: new Date().toISOString(),
    });

    await wb.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.writes[0].operation).toBe("upsert");
  });

  it("respects batch size limit", async () => {
    const responses: Response[] = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const r = new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
      responses.push(r);
      return Promise.resolve(r);
    });

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    // Enqueue 250 writes; max batch is 100, so we expect 3 POSTs.
    for (let i = 0; i < 250; i++) {
      wb.enqueue("memories", "insert", { id: `m-${i}` });
    }

    await wb.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const batch1 = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    const batch2 = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string);
    const batch3 = JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string);
    expect(batch1.writes).toHaveLength(100);
    expect(batch2.writes).toHaveLength(100);
    expect(batch3.writes).toHaveLength(50);
  });

  it("generates unique writeIds for each write", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, results: [] }), { status: 200 })
      );

    const wb = new WriteBackService({
      writeBaseUrl: "https://api.example.com",
      agentId: "agent-1",
      serviceKey: "key-1",
    });

    wb.enqueue("memories", "insert", { id: "m-1" });
    wb.enqueue("memories", "insert", { id: "m-2" });

    await wb.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.writes[0].writeId).not.toBe(body.writes[1].writeId);
    expect(body.writes[0].writeId).toBeTruthy();
    expect(body.writes[1].writeId).toBeTruthy();
  });
});

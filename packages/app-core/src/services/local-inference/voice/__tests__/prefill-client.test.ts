/**
 * Unit tests for `prefillOptimistic` (C7 — optimistic prefill client).
 *
 * Invariants under test:
 *   1. Phase 1 saves a pre-prefill checkpoint.
 *   2. Phase 2 POSTs to `/completion` with the partial text.
 *   3. Phase 3 saves a post-prefill checkpoint and returns the handle.
 *   4. The returned `tokenCount` is a positive estimate.
 *   5. The returned `prefillMs` is non-negative.
 *   6. `eotProb` is echoed back in the result.
 *   7. A `/completion` HTTP error doesn't throw — the function continues
 *      (phase 3 still runs and the result is valid).
 *   8. Validation: empty `partialText` throws; out-of-range `eotProb` throws;
 *      empty `baseUrl` throws.
 */

import { describe, expect, it, vi } from "vitest";
import { MockCheckpointManager } from "../checkpoint-manager";
import { prefillOptimistic } from "../prefill-client";

// ---------------------------------------------------------------------------
// Mock fetch builder
// ---------------------------------------------------------------------------

type FetchMock = typeof fetch & ReturnType<typeof vi.fn>;

function asFetchMock(mock: ReturnType<typeof vi.fn>): FetchMock {
  return Object.assign(mock, {
    preconnect: fetch.preconnect,
  }) as unknown as FetchMock;
}

function okFetch(): FetchMock {
  return asFetchMock(
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ content: "" }), { status: 200 }),
      ),
  );
}

function errorFetch(status = 500): FetchMock {
  return asFetchMock(
    vi
      .fn()
      .mockResolvedValue(new Response("Internal Server Error", { status })),
  );
}

function networkErrorFetch(): FetchMock {
  return asFetchMock(vi.fn().mockRejectedValue(new Error("Network error")));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prefillOptimistic", () => {
  it("Phase 1 saves a pre-prefill checkpoint", async () => {
    const mgr = new MockCheckpointManager();
    await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "hello world",
        eotProb: 0.7,
      },
      { checkpointManager: mgr, fetchImpl: okFetch() },
    );
    const saves = mgr.operations.filter((op) => op.kind === "save");
    expect(saves.length).toBeGreaterThanOrEqual(1);
    // First save is the pre-prefill checkpoint.
    const preSave = saves[0];
    expect(preSave).toMatchObject({
      kind: "save",
      slotId: "slot-1",
      name: "pre-prefill",
    });
  });

  it("Phase 3 saves a post-prefill checkpoint and the handle is returned", async () => {
    const mgr = new MockCheckpointManager();
    const result = await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "hello world",
        eotProb: 0.7,
      },
      { checkpointManager: mgr, fetchImpl: okFetch() },
    );
    const saves = mgr.operations.filter((op) => op.kind === "save");
    // Two saves: pre-prefill and post-prefill.
    expect(saves).toHaveLength(2);
    const postSave = saves[1];
    expect(postSave).toMatchObject({
      kind: "save",
      slotId: "slot-1",
      name: "post-prefill",
    });
    // Returned handle matches the post-prefill save.
    expect(result.checkpointHandle.id).toBe(postSave.handleId);
  });

  it("Phase 2 POSTs to /completion with the partial text", async () => {
    const mockFetch = okFetch();
    const mgr = new MockCheckpointManager();
    await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "how do I bake bread",
        eotProb: 0.5,
      },
      { checkpointManager: mgr, fetchImpl: mockFetch },
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8080/completion");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.n_predict).toBe(0);
    expect(body.cache_prompt).toBe(true);
    expect(body.stream).toBe(false);
    expect(body.prompt).toContain("how do I bake bread");
  });

  it("returns eotProb, tokenCount ≥ 1, and prefillMs ≥ 0", async () => {
    const result = await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "three tokens here",
        eotProb: 0.85,
      },
      { checkpointManager: new MockCheckpointManager(), fetchImpl: okFetch() },
    );
    expect(result.eotProb).toBe(0.85);
    expect(result.tokenCount).toBeGreaterThanOrEqual(1);
    expect(result.prefillMs).toBeGreaterThanOrEqual(0);
    expect(result.backend).toBe("slot-save-stub");
  });

  it("a /completion HTTP error is swallowed — result is still valid", async () => {
    const mgr = new MockCheckpointManager();
    const result = await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "error partial",
        eotProb: 0.3,
      },
      { checkpointManager: mgr, fetchImpl: errorFetch(503) },
    );
    // Phase 3 still ran — result is valid.
    expect(result.checkpointHandle).toBeDefined();
    expect(mgr.operations.filter((op) => op.kind === "save")).toHaveLength(2);
  });

  it("a network error on /completion is swallowed — result is still valid", async () => {
    const mgr = new MockCheckpointManager();
    const result = await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "network error partial",
        eotProb: 0.4,
      },
      { checkpointManager: mgr, fetchImpl: networkErrorFetch() },
    );
    expect(result.checkpointHandle).toBeDefined();
    expect(mgr.operations.filter((op) => op.kind === "save")).toHaveLength(2);
  });

  it("includes context system blocks in the /completion prompt when provided", async () => {
    const mockFetch = okFetch();
    await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "user partial",
        eotProb: 0.6,
        context: {
          systemBlocks: ["You are Eliza."],
          historyBlocks: [{ role: "assistant", content: "Hello!" }],
        },
      },
      { checkpointManager: new MockCheckpointManager(), fetchImpl: mockFetch },
    );
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.prompt).toContain("You are Eliza.");
    expect(body.prompt).toContain("Hello!");
    expect(body.prompt).toContain("user partial");
  });

  it("uses custom checkpoint names when provided", async () => {
    const mgr = new MockCheckpointManager();
    await prefillOptimistic(
      {
        baseUrl: "http://localhost:8080",
        slotId: "slot-1",
        partialText: "custom name test",
        eotProb: 0.5,
      },
      {
        checkpointManager: mgr,
        preCheckpointName: "my-pre",
        postCheckpointName: "my-post",
        fetchImpl: okFetch(),
      },
    );
    const saves = mgr.operations.filter((op) => op.kind === "save");
    expect(saves[0].name).toBe("my-pre");
    expect(saves[1].name).toBe("my-post");
  });

  // --- validation -----------------------------------------------------------

  it("throws TypeError for empty partialText", async () => {
    await expect(
      prefillOptimistic(
        {
          baseUrl: "http://localhost:8080",
          slotId: "slot-1",
          partialText: "  ",
          eotProb: 0.5,
        },
        {
          checkpointManager: new MockCheckpointManager(),
          fetchImpl: okFetch(),
        },
      ),
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError for out-of-range eotProb", async () => {
    await expect(
      prefillOptimistic(
        {
          baseUrl: "http://localhost:8080",
          slotId: "slot-1",
          partialText: "text",
          eotProb: 1.5,
        },
        {
          checkpointManager: new MockCheckpointManager(),
          fetchImpl: okFetch(),
        },
      ),
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError for empty baseUrl", async () => {
    await expect(
      prefillOptimistic(
        { baseUrl: "", slotId: "slot-1", partialText: "text", eotProb: 0.5 },
        {
          checkpointManager: new MockCheckpointManager(),
          fetchImpl: okFetch(),
        },
      ),
    ).rejects.toThrow(TypeError);
  });
});

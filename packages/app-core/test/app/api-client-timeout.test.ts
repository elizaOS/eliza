import { ApiError, ElizaClient } from "@elizaos/app-core/api";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ElizaClient request timeout handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      value: originalFetch,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it("raises typed timeout error for hung requests", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    const client = new ElizaClient("http://localhost:2138");
    const request = client.getStatus().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_001);

    const error = await request;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: "timeout",
      path: "/api/status",
    });
  });

  it("raises typed timeout error for raw export requests", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    const client = new ElizaClient("http://localhost:2138");
    const request = client
      .exportTrajectories({ format: "json" })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_001);

    const error = await request;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: "timeout",
      path: "/api/trajectories/export",
    });
  });
});

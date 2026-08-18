/**
 * SteerLiquidityService fetch deadlines — proves the production service aborts
 * on timeout via mocked hanging fetch, covering both GraphQL paths.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STEER_FETCH_TIMEOUT_MS,
  SteerLiquidityService,
} from "./steerLiquidityService";

describe("SteerLiquidityService fetch timeout", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_STEER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled GraphQL connection test at the deadline", async () => {
    const svc = new SteerLiquidityService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing steer connection");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          testGraphQLConnection: () => Promise<{
            success: boolean;
            error?: string;
          }>;
        }
      ).testGraphQLConnection();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/aborted|TimeoutError/i);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("subgraph.ormilabs.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("aborts a stalled vault GraphQL fetch at the deadline", async () => {
    const svc = new SteerLiquidityService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing steer vault");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          getVaultDataFromGraphQL: (id: string) => Promise<unknown>;
        }
      ).getVaultDataFromGraphQL("0x1111111111111111111111111111111111111111");
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("subgraph.ormilabs.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const svc = new SteerLiquidityService();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return Response.json({ data: { _meta: { block: { number: 1 } } } });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          testGraphQLConnection: () => Promise<{ success: boolean }>;
        }
      ).testGraphQLConnection();
      expect(result.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const svc = new SteerLiquidityService();
    const spy = vi.fn(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          testGraphQLConnection: () => Promise<{
            success: boolean;
            error?: string;
          }>;
        }
      ).testGraphQLConnection();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/503/);
    } finally {
      globalThis.fetch = prev;
    }
  });
});

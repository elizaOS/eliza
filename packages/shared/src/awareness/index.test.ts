/**
 * Tests for the awareness public barrel surface (src/awareness/index.ts): drives the
 * re-exported AwarenessRegistry and normalizeSummaryLine through their consumer-facing
 * entry point, covering branches the registry-level suite leaves open.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AwarenessContributor } from "../contracts/awareness.ts";
import { AwarenessRegistry, normalizeSummaryLine } from "./index.ts";

describe("awareness public surface", () => {
  const mockRuntime = {} as IAgentRuntime;

  it("composes an empty registry into the bare schema header", async () => {
    const registry = new AwarenessRegistry();
    await expect(registry.composeSummary(mockRuntime)).resolves.toBe(
      "[Self Status v1]\n",
    );
  });

  it("keeps insertion order for equal positions and sorts lower positions first", async () => {
    const registry = new AwarenessRegistry();
    const tieA: AwarenessContributor = {
      id: "tie-a",
      position: 10,
      summary: vi.fn(async () => "alpha"),
    };
    const tieB: AwarenessContributor = {
      id: "tie-b",
      position: 10,
      summary: vi.fn(async () => "beta"),
    };
    const early: AwarenessContributor = {
      id: "early",
      position: 5,
      summary: vi.fn(async () => "gamma"),
    };

    registry.register(tieA);
    registry.register(tieB);
    registry.register(early);

    const summary = await registry.composeSummary(mockRuntime);
    expect(summary.indexOf("gamma")).toBeLessThan(summary.indexOf("alpha"));
    expect(summary.indexOf("alpha")).toBeLessThan(summary.indexOf("beta"));
  });

  it("reuses the cached summary within its TTL and recomputes after expiry", async () => {
    const registry = new AwarenessRegistry();
    const summaryFn = vi.fn(async () => "volatile status");
    registry.register({
      id: "ttl-mod",
      position: 1,
      cacheTtl: 50,
      summary: summaryFn,
    });

    await registry.composeSummary(mockRuntime);
    await registry.composeSummary(mockRuntime);
    expect(summaryFn).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await registry.composeSummary(mockRuntime);
    expect(summaryFn).toHaveBeenCalledTimes(2);
  });

  it("invalidation clears only contributors subscribed to the fired event", async () => {
    const registry = new AwarenessRegistry();
    const subscriberFn = vi.fn(async () => "subscriber");
    const bystanderFn = vi.fn(async () => "bystander");
    registry.register({
      id: "subscriber",
      position: 1,
      invalidateOn: ["config-changed"],
      summary: subscriberFn,
    });
    registry.register({
      id: "bystander",
      position: 2,
      invalidateOn: ["wallet-updated"],
      summary: bystanderFn,
    });

    await registry.composeSummary(mockRuntime);
    registry.invalidate("config-changed");
    await registry.composeSummary(mockRuntime);

    expect(subscriberFn).toHaveBeenCalledTimes(2);
    expect(bystanderFn).toHaveBeenCalledTimes(1);
  });

  it("returns an empty detail digest when no contributors are registered", async () => {
    const registry = new AwarenessRegistry();
    await expect(registry.getDetail(mockRuntime, "all", "full")).resolves.toBe(
      "",
    );
  });

  it("sanitizes untrusted detail payloads but passes trusted ones through verbatim", async () => {
    const registry = new AwarenessRegistry();
    const secret = "xai-sk-1234567890abcdef1234567890abcdef12345678";
    registry.register({
      id: "guarded",
      position: 1,
      summary: vi.fn(async () => "s"),
      detail: vi.fn(async () => `key ${secret}`),
    });
    registry.register({
      id: "built-in",
      position: 2,
      trusted: true,
      summary: vi.fn(async () => "s"),
      detail: vi.fn(async () => `key ${secret}`),
    });

    const guarded = await registry.getDetail(mockRuntime, "guarded", "brief");
    expect(guarded).toBe("key [REDACTED]");
    expect(guarded).not.toContain(secret);

    const trusted = await registry.getDetail(mockRuntime, "built-in", "brief");
    expect(trusted).toBe(`key ${secret}`);
  });

  it("normalizes lone surrogates to the Unicode replacement character", () => {
    expect(normalizeSummaryLine("\uD800tail")).toBe("\uFFFDtail");
    expect(normalizeSummaryLine("well-formed ✅")).toBe("well-formed ✅");
  });
});

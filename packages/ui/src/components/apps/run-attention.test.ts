/**
 * Unit tests for run-attention: validates warning badges derivation.
 */
import { describe, expect, it } from "vitest";
import type { AppRunSummary } from "../../api";
import { getRunAttentionReasons } from "./run-attention.ts";

describe("run-attention", () => {
  it("reports offline reason when run health is offline", () => {
    const run: AppRunSummary = {
      id: "run-1",
      appId: "app-1",
      health: { state: "offline" },
      viewerAttachment: "attached",
      viewer: { url: "https://example.com" },
      supportsBackground: true,
    } as unknown as AppRunSummary;

    const reasons = getRunAttentionReasons(run);
    expect(reasons).toContain("Run is offline");
  });

  it("reports detached viewer reason", () => {
    const run: AppRunSummary = {
      id: "run-2",
      appId: "app-2",
      health: { state: "healthy" },
      viewerAttachment: "detached",
      viewer: { url: "https://example.com" },
      supportsBackground: true,
      lastHeartbeatAt: new Date().toISOString(),
    } as unknown as AppRunSummary;

    const reasons = getRunAttentionReasons(run);
    expect(reasons).toContain("Viewer is detached");
  });

  it("reports stale heartbeat when heartbeat exceeds stale threshold", () => {
    const now = Date.now();
    const staleTime = new Date(now - 5 * 60 * 1000).toISOString();
    const run: AppRunSummary = {
      id: "run-3",
      appId: "app-3",
      health: { state: "healthy" },
      viewerAttachment: "attached",
      viewer: { url: "https://example.com" },
      supportsBackground: true,
      lastHeartbeatAt: staleTime,
    } as unknown as AppRunSummary;

    const reasons = getRunAttentionReasons(run, now);
    expect(reasons).toContain("Heartbeat is stale");
  });
});

import { describe, expect, it } from "vitest";
import {
  boundedContentView,
  canonicalProviderPair,
  orchestratorContentRef,
} from "../services/durable-content.js";

describe("durable content views", () => {
  it("passes short content through whole", () => {
    const ref = orchestratorContentRef("session-output", "sess-1");
    const view = boundedContentView("hello", 100, ref);
    expect(view).toEqual({ view: "hello", truncated: false });
  });

  it("a partial view carries the continuation marker and a ReadView", () => {
    const ref = orchestratorContentRef("task", "task-1");
    const full = "x".repeat(500);
    const view = boundedContentView(full, 120, ref);
    expect(view.truncated).toBe(true);
    expect(view.view.length).toBeLessThanOrEqual(120);
    expect(view.view).toContain("full content: acpx-task:task-1");
    expect(view.read?.reference.kind).toBe("tool-result");
    expect(view.read?.slice.hasMore).toBe(true);
    expect(view.read?.slice.completeness).toBe("partial-recoverable");
    expect(view.read?.slice.range.total).toBe(500);
    expect(view.read?.slice.sliceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("references are opaque-token safe", () => {
    const ref = orchestratorContentRef(
      "task-meta",
      "id with spaces/and:slashes",
      "canonicalPrBody",
    );
    expect(ref.ref).toMatch(/^[A-Za-z0-9._:~-]{1,256}$/);
  });

  it("canonical/provider pair records the derivation", () => {
    const pair = canonicalProviderPair("a".repeat(200), 120);
    expect(pair.canonical.length).toBe(200);
    expect(pair.provider.length).toBeLessThanOrEqual(120);
    expect(pair.truncated).toBe(true);
    expect(canonicalProviderPair("short", 120).truncated).toBe(false);
  });
});
